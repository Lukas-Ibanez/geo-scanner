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
import { verifyTurnstile } from '../../lib/turnstile';

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

    let payload: { url?: unknown; 'cf-turnstile-response'?: unknown };
    try {
      payload = (await request.json()) as {
        url?: unknown;
        'cf-turnstile-response'?: unknown;
      };
    } catch {
      return json({ error: 'No pudimos leer los datos enviados.' }, 400);
    }

    // Validación anti-bot (Turnstile). Solo se valida si el cliente lo pide
    // explícitamente (fase explícita 'scan'). Como este endpoint se invoca
    // DESPUÉS de un scan base válido, confiamos en esa validación previa y
    // saltamos Turnstile (lo mismo que en /api/scan con phase='unlock').
    const ip =
      request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';
    const phase = payload?.phase === 'scan' ? 'scan' : 'unlock';
    if (phase === 'scan') {
      const turn = await verifyTurnstile(
        env.TURNSTILE_SECRET,
        payload?.['cf-turnstile-response'],
        ip
      );
      if (!turn.success) {
        return json(
          { error: turn.error || 'Verificación anti-bot falló. Probá de nuevo.' },
          403
        );
      }
    }

    const valid = validateAndNormalize(payload?.url, null);
    if (!valid.ok) return json({ error: valid.error }, 400);
    const { url, origin } = valid.data;

    // Mismo rate-limit que /api/scan (mismo KV, mismo contador). Si ya alcanzó
    // el tope por escaneo, no dejamos pedir sugerencias tampoco — es la misma
    // superficie de abuso.
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

    // 1 fetch del sitio + hasta 2 calls a Gemini (una con signals, fallback
    // con googleSearch si no pudimos leer el sitio — orange-to-orange).
    // Caben de sobra en el límite de 50 subrequests.
    const site = await fetchSite(origin, url);
    const signals = site.ok && site.html ? await parseHtml(site.html) : null;

    // Si signals está vacío, suggestCompetitors hace fallback a Gemini con
    // googleSearch — Google hace el fetch por nosotros y saltea el orange-to-orange.
    const competitors = await suggestCompetitors({ signals, url }, env);
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