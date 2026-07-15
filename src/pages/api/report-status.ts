// GET /api/report-status?token=<uuid> — poll del estado del informe detallado.
// Cuando el unlock responde rápido, el detallado se genera en segundo plano y
// se guarda bajo el token. El cliente hace poll de este endpoint hasta que el
// resultado está listo, y ahí lo renderiza inline + habilita el PDF.
//
// Respuestas:
//   { ready: true, result }  → el detallado ya está cacheado bajo el token.
//   { ready: false }         → todavía generándose (o el token no trae result).
//   404                      → token inexistente/vencido.
import type { APIRoute } from 'astro';
import { getReportToken } from '../../lib/cache';

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

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const env = locals.runtime.env;
    const token = url.searchParams.get('token');
    if (!token) return json({ ready: false, error: 'Falta el token.' }, 400);

    const data = await getReportToken(env.SCAN_CACHE, token);
    if (!data) return json({ ready: false, error: 'Token inexistente o vencido.' }, 404);

    if (data.result) return json({ ready: true, result: data.result });
    return json({ ready: false });
  } catch (err) {
    console.error('report-status failed:', err);
    return json({ ready: false, error: 'Error consultando el estado.' }, 500);
  }
};
