// POST /api/suggest-competitors — usa Claude para sugerir 3-5 competidores
// REALES del mismo rubro que el sitio pasado. Pensado para alimentar el botón
// "Detectar competidores con IA" del unlock del informe detallado. NO invierte
// el flujo de /api/scan: vive aparte y se llama solo si el usuario lo pide.
import type { APIRoute } from 'astro';
import { validateAndNormalize } from '../../lib/validate';
import { fetchSite } from '../../lib/fetchSite';
import { parseHtml } from '../../lib/parseHtml';
import { suggestCompetitors } from '../../lib/competitorSuggest';
import { checkRateLimit } from '../../lib/rateLimit';

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

    let payload: { url?: unknown };
    try {
      payload = (await request.json()) as { url?: unknown };
    } catch {
      return json({ error: 'No pudimos leer los datos enviados.' }, 400);
    }

    const valid = validateAndNormalize(payload?.url, null);
    if (!valid.ok) return json({ error: valid.error }, 400);
    const { url, origin } = valid.data;

    // Mismo rate-limit que /api/scan (mismo KV, mismo contador). Si ya alcanzó
    // el tope por escaneo, no dejamos pedir sugerencias tampoco — es la misma
    // superficie de abuso.
    const ip = request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';
    const whitelist = (env.RATE_LIMIT_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!whitelist.includes(ip)) {
      const limit = intEnv(env.RATE_LIMIT_PER_HOUR, 5);
      const rl = await checkRateLimit(env.SCAN_CACHE, ip, limit);
      if (!rl.allowed) {
        return json(
          { error: 'Has hecho demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' },
          429
        );
      }
    }

    // 1 fetch del sitio + 1 call a Claude. Caben de sobra en el límite de 50 subrequests.
    const site = await fetchSite(origin, url);
    if (!site.ok || !site.html) {
      return json(
        {
          error:
            'No pudimos leer este sitio. Puede estar bloqueando lectores automáticos o no estar disponible.',
        },
        502
      );
    }
    const signals = await parseHtml(site.html);

    const competitors = await suggestCompetitors(signals, env);
    return json({ competitors });
  } catch (err) {
    console.error('suggest-competitors failed:', err);
    return json(
      { error: 'Tuvimos un problema sugiriendo competidores. Inténtalo de nuevo en un momento.' },
      500
    );
  }
};

export const GET: APIRoute = () =>
  json({ error: 'Usa POST para pedir sugerencias de competidores.' }, 405);