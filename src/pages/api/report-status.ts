// GET /api/report-status?token=<uuid> — poll del estado del informe detallado.
// Cuando el unlock responde rápido, el detallado se genera en segundo plano y
// se guarda bajo el token. El cliente hace poll de este endpoint hasta que el
// resultado está listo, y ahí lo renderiza inline + habilita el PDF.
//
// Respuestas:
//   { ready: true, result }  → el detallado ya está cacheado bajo el token.
//   { ready: false, failed: true, reason } → el background falló (le decimos
//                                al cliente en vez del mensaje "te llega por correo").
//   { ready: false }          → todavía generándose (o el token no trae result).
//   404                       → token inexistente/vencido.
//   429                       → rate limit por IP.
//
// Rate limit: aunque el token es UUID v4 (122 bits) y brute-force es
// impráctico, un atacante con muchos threads puede tirar la KV de Cloudflare
// (que factura reads). 120/h por IP es generoso para un usuario real (un poll
// cada 4s = 900/h, pero a los 2.7 min termina; en la práctica <100/h).
import type { APIRoute } from 'astro';
import { getReportToken } from '../../lib/cache';
import { checkRateLimit } from '../../lib/rateLimit';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const GET: APIRoute = async ({ url, locals, request, clientAddress }) => {
  try {
    const env = locals.runtime.env;
    const ip =
      request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';

    // Rate limit por IP, contador dedicado ("report-status") separado del de
    // scan / passphrase-check para que un usuario legítimo no gaste cuota de
    // otro endpoint.
    const whitelist = (env.RATE_LIMIT_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!whitelist.includes(ip)) {
      const limit = intEnv(env.REPORT_STATUS_PER_HOUR, 120);
      const rl = await checkRateLimit(env.SCAN_CACHE, ip, limit, 'report-status');
      if (!rl.allowed) {
        return json(
          { ready: false, error: 'Demasiadas consultas. Vuelve a intentar en un minuto.' },
          429
        );
      }
    }

    const token = url.searchParams.get('token');
    if (!token) return json({ ready: false, error: 'Falta el token.' }, 400);

    const data = await getReportToken(env.SCAN_CACHE, token);
    if (!data) return json({ ready: false, error: 'Token inexistente o vencido.' }, 404);

    if (data.failed) {
      // El background detallado falló. Le avisamos al cliente para que muestre
      // un error real en vez del mensaje "te llega por correo".
      return json({ ready: false, failed: true, reason: data.failedReason || 'Error generando el informe.' });
    }
    if (data.result) return json({ ready: true, result: data.result });
    return json({ ready: false });
  } catch (err) {
    console.error('report-status failed:', err);
    return json({ ready: false, error: 'Error consultando el estado.' }, 500);
  }
};
