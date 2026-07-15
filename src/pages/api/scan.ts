// POST /api/scan — endpoint HTTP delgado sobre buildScan (src/lib/scanFlow.ts).
// Hace: parseo del body, validación anti-bot (Turnstile), llamada a buildScan,
// guardado del lead, proyección al cliente (gating), envío del informe por
// correo, y serialización JSON.
import type { APIRoute } from 'astro';
import { buildScan, ScanError } from '../../lib/scanFlow';
import { accessLevel, projectForClient } from '../../lib/entitlement';
import { getCachedScan, putReportToken } from '../../lib/cache';
import { saveLead } from '../../lib/leads';
import { sendReportEmail } from '../../lib/email';
import { verifyTurnstile } from '../../lib/turnstile';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime.env;

    // 1) Body
    let payload: {
      url?: unknown;
      email?: unknown;
      passphrase?: unknown;
      competitors?: unknown;
      phase?: unknown;
      'cf-turnstile-response'?: unknown;
    };
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'No pudimos leer los datos enviados.' }, 400);
    }

    // 2) Validación anti-bot (Turnstile). Solo se valida en el primer submit
    //    del escaneo (phase='scan'). En el unlock (phase='unlock') confiamos
    //    en el scan previo: el unlock presupone que el primer POST pasó y
    //    gastó un análisis de IA, así que no vale la pena gastar otro Turnstile.
    const ip =
      request.headers.get('CF-Connecting-IP') || clientAddress || 'unknown';
    const phase = payload?.phase === 'unlock' ? 'unlock' : 'scan';
    if (phase === 'scan') {
      const turnstileToken =
        typeof payload?.['cf-turnstile-response'] === 'string'
          ? payload['cf-turnstile-response']
          : undefined;
      const turn = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, ip);
      if (!turn.success) {
        return json(
          { error: turn.error || 'Verificación anti-bot falló. Inténtalo de nuevo.' },
          403
        );
      }
    }

    // 3) Construir el flujo (valida, rate-limita, fetcha, evalúa, detailed).
    const passphrase =
      typeof payload?.passphrase === 'string' ? payload.passphrase : null;
    const competitors = Array.isArray(payload?.competitors)
      ? (payload.competitors.filter((c): c is string => typeof c === 'string'))
      : [];

    let flow;
    try {
      flow = await buildScan(env, ip, {
        url: typeof payload?.url === 'string' ? payload.url : '',
        email: typeof payload?.email === 'string' ? payload.email : null,
        passphrase,
        competitors,
      });
    } catch (err) {
      if (err instanceof ScanError) return json({ error: err.userMessage }, err.status);
      throw err;
    }
    const { result: full, level, email, entitled } = flow;

    // 3) Guardar el lead (cada submit con email, aunque venga de caché).
    if (email) {
      await saveLead(env.DB, {
        email,
        url: full.url,
        domain: full.domain,
        finalScore: full.finalScore,
        aiAvailable: full.aiAnalysisAvailable,
        ip,
        userAgent: request.headers.get('user-agent') || '',
      });
    }

    // 4) Proyectar al cliente según el nivel.
    const projected = projectForClient(full, level);

    // 5) Generar token de acceso al PDF (solo si level==='detailed'). El token
    // reemplaza a la passphrase en la URL: es random, se guarda en KV con la
    // URL+competidores, y vence a los 7 días. /report valida el token.
    // La passphrase NUNCA sale del server — no aparece ni en la URL del mail
    // ni en los logs del browser/servidor.
    let reportToken: string | undefined;
    let reportUrl: string | undefined;
    if (level === 'detailed') {
      reportToken = crypto.randomUUID();
      await putReportToken(env.SCAN_CACHE, reportToken, {
        url: full.url,
        competitors,
      });
      const publicUrl = (env.PUBLIC_URL || 'https://geo.lukasibanez.dev').replace(/\/$/, '');
      reportUrl = `${publicUrl}/report?token=${reportToken}`;
    }

    // 6) Email: cuando el lead desbloqueó el detalle y hay recomendaciones.
    if (email && entitled && projected.recommendations && projected.recommendations.length) {
      const send = sendReportEmail(env, email, projected, {
        reportToken,
      });
      const waitUntil = locals.runtime.ctx?.waitUntil?.bind(locals.runtime.ctx);
      if (waitUntil) waitUntil(send);
      else await send;
    }

    return json({ ...projected, reportUrl }, 200);
  } catch (err) {
    console.error('scan failed:', err);
    return json(
      {
        error: 'Tuvimos un problema procesando tu sitio. Inténtalo de nuevo en un momento.',
      },
      500
    );
  }
};

export const GET: APIRoute = () =>
  json({ error: 'Usa POST para escanear un sitio.' }, 405);

// `accessLevel` y `getCachedScan` reexportados para no romper imports legacy
// (no se usan aquí, pero algunos tests pueden traerlos desde este módulo).
export { accessLevel, getCachedScan };