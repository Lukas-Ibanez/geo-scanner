// Flujo compartido de escaneo. Lo usan tanto el endpoint /api/scan como la
// página /report para que ambos produzcan exactamente el mismo ScanResult a
// partir de (url, email, passphrase, competitors). Centraliza: validación,
// rate limit, caché, fetch, parse, evaluación de contenido, combinación de
// puntajes, y la construcción del informe detallado cuando aplica.
//
// Devuelve { result, level, email, entitled, site, signals } donde `result`
// es el ScanResult COMPLETO (con detailedReport si level==='detailed') antes
// de proyectarlo al cliente. El caller (scan.ts) hace la proyección con
// projectForClient y manda el correo; report.astro lo usa tal cual para
// renderizar el PDF.
import type {
  ScanResult,
  AccessLevel,
  FetchedSite,
  SiteSignals,
} from './types';
import { validateAndNormalize } from './validate';
import { fetchSite } from './fetchSite';
import { parseHtml } from './parseHtml';
import { computeTechnical } from './technicalScore';
import { evaluateContent } from './content';
import { combineScores } from './score';
import { accessLevel } from './entitlement';
import { buildDetailedReport } from './detailed';
import { getCachedScan, putCachedScan } from './cache';
import { checkRateLimit } from './rateLimit';

export interface ScanFlowParams {
  url: string;
  email?: string | null;
  passphrase?: string | null;
  competitors?: string[];
  /**
   * true si el caller ya validó el acceso (ej. /report con token válido).
   * En ese caso forzamos level='detailed' sin chequear passphrase, y no
   * aplicamos rate-limit (ya pasó por el unlock del UI).
   */
  accessAlreadyGranted?: boolean;
}

export interface ScanFlowResult {
  result: ScanResult;
  level: AccessLevel;
  email: string | null;
  entitled: boolean;
  site: FetchedSite | null;
  signals: SiteSignals | null;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Error de dominio que el caller debe traducir a HTTP. */
export class ScanError extends Error {
  constructor(public status: number, public userMessage: string) {
    super(userMessage);
  }
}

export async function buildScan(
  env: Env,
  ip: string,
  params: ScanFlowParams
): Promise<ScanFlowResult> {
  // 1) Validar entrada (la passphrase no se valida — accessLevel decide).
  const valid = validateAndNormalize(params.url, params.email);
  if (!valid.ok) throw new ScanError(400, valid.error);
  const { url, origin, domain, email } = valid.data;

  // 2) Rate limit por IP (con whitelist que lo omite). Si el caller ya validó
  // el acceso (ej. /report con token), no aplicamos rate-limit: ya pasó por el
  // unlock del UI.
  const whitelist = (env.RATE_LIMIT_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!params.accessAlreadyGranted && !whitelist.includes(ip)) {
    const limit = intEnv(env.RATE_LIMIT_PER_HOUR, 5);
    const rl = await checkRateLimit(env.SCAN_CACHE, ip, limit);
    if (!rl.allowed) {
      throw new ScanError(
        429,
        'Has hecho demasiados escaneos. Espera un momento e inténtalo de nuevo.'
      );
    }
  }

  const ttlHours = intEnv(env.CACHE_TTL_HOURS, 6);
  // Si el caller ya validó el acceso (token de reporte válido), forzamos
  // 'detailed' sin chequear passphrase — la passphrase nunca viaja al server
  // en este path.
  const level: AccessLevel = params.accessAlreadyGranted
    ? 'detailed'
    : accessLevel(
        { email, passphrase: params.passphrase },
        env.DETAILED_PASSPHRASE ?? null
      );
  const entitled = level !== 'teaser';

  // 3) Caché por dominio (ahorra cuota de Gemini y evita re-escaneos).
  let full = await getCachedScan(env.SCAN_CACHE, domain);
  let site: FetchedSite | null = null;
  let signals: SiteSignals | null = null;

  if (!full) {
    // 4) Descargar + parsear + puntuar (técnico + IA) + combinar.
    site = await fetchSite(origin, url);
    if (!site.ok || !site.html) {
      console.error('fetchSite failed', {
        url,
        status: site.status,
        htmlLen: site.html.length,
      });
      throw new ScanError(
        502,
        'No pudimos leer este sitio. Puede estar bloqueando lectores automáticos o no estar disponible en este momento.'
      );
    }

    signals = await parseHtml(site.html);
    const tech = computeTechnical(signals, site);
    const content = await evaluateContent(signals, env);
    if (!content.available) {
      console.error('content eval degraded', {
        provider: env.AI_PROVIDER || 'hybrid',
        reason: content.debug,
      });
    }
    const { finalScore, subScores, verdict } = combineScores(tech, content);
    const passed = tech.checks.filter((c) => c.passed).length;

    full = {
      url,
      domain,
      scannedAt: new Date().toISOString(),
      fromCache: false,
      accessLevel: 'teaser', // placeholder; projectForClient sella el real
      finalScore,
      verdict,
      subScores,
      aiAnalysisAvailable: content.available,
      blocksAiBots: tech.blocksAiBots,
      recommendationsCount: content.recomendaciones.length,
      technicalSummary: { passed, total: tech.checks.length },
      locked: false,
      recommendations: content.recomendaciones,
      technicalChecks: tech.checks,
      detailedReport: null,
    };

    // Solo se cachea si el análisis con IA salió bien — si degradó, queremos
    // que el próximo intento reintente la IA en vez de servir el degradado.
    if (full.aiAnalysisAvailable) {
      await putCachedScan(env.SCAN_CACHE, domain, full, ttlHours);
    }
  } else {
    full = { ...full, fromCache: true };
  }

  // 5) Informe detallado (nivel 'detailed'). Nunca se cachea: depende de los
  // competidores del cliente. Si el base salió de caché, re-fetch del sitio
  // del cliente (el informe detallado necesita su contenido).
  if (level === 'detailed') {
    if (!site || !signals) {
      site = await fetchSite(origin, url);
      signals = site.ok && site.html ? await parseHtml(site.html) : null;
    }
    full = {
      ...full,
      detailedReport:
        site && signals
          ? await buildDetailedReport({
              signals,
              site,
              competitors: params.competitors || [],
              env,
            })
          : null,
    };
  } else {
    full = { ...full, detailedReport: null };
  }

  return { result: full, level, email, entitled, site, signals };
}