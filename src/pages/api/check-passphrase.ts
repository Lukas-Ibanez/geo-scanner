// POST /api/check-passphrase — valida si una passphrase coincide con la
// configurada en DETAILED_PASSPHRASE. Pensado para que el cliente pueda
// habilitar la sección de competidores SOLO con código real (no con cualquier
// string de 4+ chars) y no gastar tokens de IA en usos sin derecho.
//
// Es un string compare contra un secret server-side: barato, sin IA, sin
// fetch, sin DB. Rate-limit por IP (mismo KV que /api/scan) para frenar
// brute force. Comparación timing-safe para no filtrar longitud por timing.
import type { APIRoute } from 'astro';
import { checkRateLimit } from '../../lib/rateLimit';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // No queremos que un proxy cachee el resultado — depende del input.
      'cache-control': 'no-store',
    },
  });
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Comparación timing-safe de dos strings de igual/ desigual longitud. Devuelve
// true solo si los dos son idénticos Y no vacíos. Igual longitud siempre para
// no exponer largo por timing.
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Rellenamos al más largo con un caracter dummy para que la comparación
  // siempre recorra la longitud del más largo (mitiga timing por longitud).
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime.env;
    const ip =
      request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';

    // Rate-limit por IP, contador dedicado ("passphrase-check") separado
    // del de /api/scan ("scan") para que un usuario legítimo no gaste cuota
    // del scan en pruebas del código y viceversa. Tope bajo (30/h) porque
    // este endpoint es barato pero expone brute force si se lo deja sin freno.
    const whitelist = (env.RATE_LIMIT_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!whitelist.includes(ip)) {
      const limit = intEnv(env.PASSPHRASE_CHECK_PER_HOUR, 30);
      const rl = await checkRateLimit(env.SCAN_CACHE, ip, limit, 'passphrase-check');
      if (!rl.allowed) {
        return json(
          {
            valid: false,
            error:
              'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
          },
          429
        );
      }
    }

    let body: { passphrase?: unknown };
    try {
      body = (await request.json()) as { passphrase?: unknown };
    } catch {
      return json({ valid: false, error: 'Body inválido.' }, 400);
    }

    if (typeof body?.passphrase !== 'string') {
      return json({ valid: false, error: 'Falta la passphrase.' }, 400);
    }
    const provided = body.passphrase.trim();

    // Si el server no tiene passphrase configurada, no hay nada que validar —
    // bloqueamos por seguridad (no queremos que el endpoint apruebe todo).
    const expected = (env.DETAILED_PASSPHRASE || '').trim();
    if (!expected) {
      return json({ valid: false, error: 'Código no configurado.' }, 503);
    }

    const valid = safeEqual(provided, expected);
    // No revelamos en el mensaje si el código existe o no — solo "válido/no válido".
    return json({ valid });
  } catch (err) {
    console.error('check-passphrase failed:', err);
    return json(
      { valid: false, error: 'No pudimos validar el código en este momento.' },
      500
    );
  }
};

export const GET: APIRoute = () =>
  json({ error: 'Usa POST para validar la passphrase.' }, 405);
