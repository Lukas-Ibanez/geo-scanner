// POST /api/scan — orquesta todo el flujo de escaneo GEO.
import type { APIRoute } from 'astro';
import { validateAndNormalize } from '../../lib/validate';
import { fetchSite } from '../../lib/fetchSite';
import { parseHtml } from '../../lib/parseHtml';
import { computeTechnical } from '../../lib/technicalScore';
import { evaluateContent } from '../../lib/gemini';
import { combineScores } from '../../lib/score';
import { isEntitled, projectForClient } from '../../lib/entitlement';
import { getCachedScan, putCachedScan } from '../../lib/cache';
import { checkRateLimit } from '../../lib/rateLimit';
import { saveLead } from '../../lib/leads';

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
  let payload: { url?: unknown; email?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'No pudimos leer los datos enviados.' }, 400);
  }

  const valid = validateAndNormalize(payload?.url, payload?.email);
  if (!valid.ok) return json({ error: valid.error }, 400);
  const { url, origin, domain, email } = valid.data;

  // 2) Rate limit por IP
  const ip = request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';
  const limit = intEnv(env.RATE_LIMIT_PER_HOUR, 5);
  const rl = await checkRateLimit(env.SCAN_CACHE, ip, limit);
  if (!rl.allowed) {
    return json({ error: 'Has hecho demasiados escaneos. Espera un momento e inténtalo de nuevo.' }, 429);
  }

  const ttlHours = intEnv(env.CACHE_TTL_HOURS, 6);
  const entitled = isEntitled({ email });

  // 3) Caché por dominio (ahorra cuota de Gemini y evita reescaneos)
  let full = await getCachedScan(env.SCAN_CACHE, domain);

  if (!full) {
    // 4) Descargar el sitio + archivos auxiliares
    const site = await fetchSite(origin, url);
    if (!site.ok || !site.html) {
      return json({ error: 'No pudimos acceder a tu sitio. Revisa la dirección e inténtalo de nuevo.' }, 502);
    }

    // 5) Parsear, puntuar (técnico + IA) y combinar
    const signals = await parseHtml(site.html);
    const tech = computeTechnical(signals, site);
    const content = await evaluateContent(signals, env);
    const { finalScore, subScores, verdict } = combineScores(tech, content);
    const passed = tech.checks.filter((c) => c.passed).length;

    full = {
      url,
      domain,
      scannedAt: new Date().toISOString(),
      fromCache: false,
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
    };

    // 6) Guardar en caché
    await putCachedScan(env.SCAN_CACHE, domain, full, ttlHours);
  } else {
    full = { ...full, fromCache: true };
  }

  // 7) Capturar el lead (cada submit con email, aunque el resultado venga de caché)
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

  // 8) Devolver la proyección según el acceso (teaser vs full)
  return json(projectForClient(full, entitled), 200);
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
