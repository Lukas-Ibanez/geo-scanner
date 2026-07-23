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

    const rawUrl = typeof payload?.url === 'string' ? payload.url : '';
    let flow;
    try {
      flow = await buildScan(env, ip, {
        url: rawUrl,
        email: typeof payload?.email === 'string' ? payload.email : null,
        passphrase,
        competitors,
        // Foreground: solo el puntaje base (rápido). Si es 'detailed', el informe
        // se genera en segundo plano (abajo) para que el unlock responda al toque.
        skipDetailed: true,
      });
    } catch (err) {
      if (err instanceof ScanError) return json({ error: err.userMessage }, err.status);
      throw err;
    }
    const { result: full, level, email, entitled } = flow;
    const waitUntil = locals.runtime.ctx?.waitUntil?.bind(locals.runtime.ctx);

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

    // 4) Nivel 'detailed': respondemos YA con el puntaje base (proyectado como
    // 'full') y generamos el informe detallado en SEGUNDO PLANO. El cliente hace
    // poll a /api/report-status con el token hasta que esté listo. El token se
    // crea vacío (pendiente) y se completa con el resultado al terminar.
    if (level === 'detailed') {
      const reportToken = crypto.randomUUID();
      const publicUrl = (env.PUBLIC_URL || 'https://geo.lukasibanez.dev').replace(/\/$/, '');
      const reportUrl = `${publicUrl}/report?token=${reportToken}`;
      await putReportToken(env.SCAN_CACHE, reportToken, { url: full.url, competitors });

      const generateDetailed = async () => {
        try {
          const dflow = await buildScan(env, ip, {
            url: rawUrl,
            email,
            passphrase,
            competitors,
            accessAlreadyGranted: true,
          });
          const dprojected = projectForClient(dflow.result, 'detailed');
          // Completa el token con el reporte → poll y /report lo sirven al instante.
          await putReportToken(env.SCAN_CACHE, reportToken, {
            url: full.url,
            competitors,
            result: dprojected,
          });
          if (email && dprojected.recommendations && dprojected.recommendations.length) {
            await sendReportEmail(env, email, dprojected, { reportToken });
          }
        } catch (e) {
          // Marcamos el token como fallido para que /api/report-status y /report
          // puedan contárselo al usuario en vez del mensaje esperanzador
          // "te llegará por correo" (que sería MENTIRA si el build falló).
          // Sin esto, el cliente hace poll ciego por 2.7 min, ve el mensaje
          // esperanzador, y nunca recibe nada. Bug clásico de UX.
          console.error('background detailed failed:', e);
          try {
            await putReportToken(env.SCAN_CACHE, reportToken, {
              url: full.url,
              competitors,
              failed: true,
              failedReason: e instanceof Error ? e.message : String(e),
            });
          } catch (markErr) {
            console.error('background: no pude marcar el token como fallido', markErr);
          }
        }
      };
      // En prod waitUntil corre en segundo plano; en local (sin ctx) hacemos await.
      if (waitUntil) waitUntil(generateDetailed());
      else await generateDetailed();

      const projectedBase = projectForClient(full, 'full');
      return json({ ...projectedBase, reportToken, reportUrl, detailedPending: true }, 200);
    }

    // 5) Niveles 'full'/'teaser': proyectar y (si aplica) enviar correo inline.
    const projected = projectForClient(full, level);
    if (email && entitled && projected.recommendations && projected.recommendations.length) {
      const send = sendReportEmail(env, email, projected, {});
      if (waitUntil) waitUntil(send);
      else await send;
    }
    return json({ ...projected }, 200);
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