// POST /api/scan — orquesta todo el flujo de escaneo GEO.
import type { APIRoute } from 'astro';
import type { FetchedSite, SiteSignals } from '../../lib/types';
import { validateAndNormalize } from '../../lib/validate';
import { fetchSite } from '../../lib/fetchSite';
import { parseHtml } from '../../lib/parseHtml';
import { computeTechnical } from '../../lib/technicalScore';
import { evaluateContent } from '../../lib/content';
import { combineScores } from '../../lib/score';
import { accessLevel, projectForClient } from '../../lib/entitlement';
import { buildDetailedReport } from '../../lib/detailed';
import { getCachedScan, putCachedScan } from '../../lib/cache';
import { checkRateLimit } from '../../lib/rateLimit';
import { saveLead } from '../../lib/leads';
import { sendReportEmail } from '../../lib/email';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
  const env = locals.runtime.env;

  // 1) Leer y validar el cuerpo
  let payload: { url?: unknown; email?: unknown; passphrase?: unknown; competitors?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'No pudimos leer los datos enviados.' }, 400);
  }

  const valid = validateAndNormalize(payload?.url, payload?.email);
  if (!valid.ok) return json({ error: valid.error }, 400);
  const { url, origin, domain, email } = valid.data;

  // Entradas del nivel 'detailed' (informe de pago).
  const passphrase = typeof payload?.passphrase === 'string' ? payload.passphrase : null;
  const competitors = Array.isArray(payload?.competitors)
    ? payload.competitors.filter((c): c is string => typeof c === 'string')
    : [];

  // 2) Rate limit por IP (con whitelist que lo omite, p.ej. tu propia IP)
  const ip = request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';
  const whitelist = (env.RATE_LIMIT_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!whitelist.includes(ip)) {
    const limit = intEnv(env.RATE_LIMIT_PER_HOUR, 5);
    const rl = await checkRateLimit(env.SCAN_CACHE, ip, limit);
    if (!rl.allowed) {
      return json({ error: 'Has hecho demasiados escaneos. Espera un momento e inténtalo de nuevo.' }, 429);
    }
  }

  const ttlHours = intEnv(env.CACHE_TTL_HOURS, 6);
  // Nivel de acceso: 'detailed' (passphrase) | 'full' (email) | 'teaser'.
  // El email del informe se dispara para full/detailed (como hoy el entitled).
  const level = accessLevel({ email, passphrase }, env.DETAILED_PASSPHRASE ?? null);
  const entitled = level !== 'teaser';

  // 3) Caché por dominio (ahorra cuota de Gemini y evita reescaneos).
  //    El informe detallado NO se cachea (depende de los competidores del cliente);
  //    si el base sale de caché, signals/site quedan en null y se obtienen aparte.
  let full = await getCachedScan(env.SCAN_CACHE, domain);
  let site: FetchedSite | null = null;
  let signals: SiteSignals | null = null;

  if (!full) {
    // 4) Descargar el sitio + archivos auxiliares
    site = await fetchSite(origin, url);
    if (!site.ok || !site.html) {
      // Log para diagnóstico (visible con `wrangler pages deployment tail`):
      // status 403/406/503/1020 = el sitio bloquea lectores automáticos; 0 = timeout/red.
      console.error('fetchSite failed', { url, status: site.status, htmlLen: site.html.length });
      return json(
        {
          error:
            'No pudimos leer este sitio. Puede estar bloqueando lectores automáticos o no estar disponible en este momento. Prueba con otra página.',
        },
        502
      );
    }

    // 5) Parsear, puntuar (técnico + IA) y combinar
    signals = await parseHtml(site.html);
    const tech = computeTechnical(signals, site);
    const content = await evaluateContent(signals, env);
    if (!content.available) {
      // Visible con `wrangler pages deployment tail` para diagnosticar el proveedor de IA.
      console.error('content eval degraded', { provider: env.AI_PROVIDER || 'hybrid', reason: content.debug });
    }
    const { finalScore, subScores, verdict } = combineScores(tech, content);
    const passed = tech.checks.filter((c) => c.passed).length;

    full = {
      url,
      domain,
      scannedAt: new Date().toISOString(),
      fromCache: false,
      accessLevel: 'teaser', // placeholder; projectForClient sella el nivel real
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
      detailedReport: null, // se computa por request si level==='detailed' (no se cachea)
    };

    // 6) Guardar en caché SOLO si el análisis con IA se pudo hacer. Si la IA
    //    degradó (cuota/timeout), no cacheamos: lo valioso es el análisis con IA
    //    y no queremos congelar un resultado sin IA durante horas; así el próximo
    //    intento reintenta la IA en vez de servir el degradado desde caché.
    if (full.aiAnalysisAvailable) {
      await putCachedScan(env.SCAN_CACHE, domain, full, ttlHours);
    }
  } else {
    full = { ...full, fromCache: true };
  }

  // 7) Informe detallado (nivel 'detailed'): se computa SIEMPRE en cada request,
  //    nunca se cachea (depende de los competidores que ingresa el cliente).
  if (level === 'detailed') {
    // Si el base vino de caché no tenemos signals/site → obtenerlos ahora, porque
    // el informe detallado necesita el contenido del sitio del cliente.
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
              competitors,
              env,
            })
          : null,
    };
  } else {
    full = { ...full, detailedReport: null };
  }

  // 8) Capturar el lead (cada submit con email, aunque el resultado venga de caché)
  if (email) {
    await saveLead(env.DB, {
      email,
      url,
      domain,
      finalScore: full.finalScore,
      aiAvailable: full.aiAnalysisAvailable,
      ip,
      userAgent: request.headers.get('user-agent') || '',
    });
  }

  // 9) Proyectar según el acceso (teaser | full | detailed)
  const projected = projectForClient(full, level);

  // 10) Enviar el informe por correo cuando el lead desbloqueó el detalle.
  //    Best-effort en segundo plano (waitUntil) para no añadir latencia a la respuesta.
  if (email && entitled && projected.recommendations && projected.recommendations.length) {
    const send = sendReportEmail(env, email, projected);
    const waitUntil = locals.runtime.ctx?.waitUntil?.bind(locals.runtime.ctx);
    if (waitUntil) waitUntil(send);
    else await send;
  }

  return json(projected, 200);
  } catch (err) {
    // Red de seguridad: cualquier error inesperado devuelve JSON limpio (no una
    // página de error 500), para que el cliente muestre un mensaje y se pueda ver
    // en `wrangler pages deployment tail`.
    console.error('scan failed:', err);
    return json(
      { error: 'Tuvimos un problema procesando tu sitio. Inténtalo de nuevo en un momento.' },
      500
    );
  }
};

export const GET: APIRoute = () => json({ error: 'Usa POST para escanear un sitio.' }, 405);
