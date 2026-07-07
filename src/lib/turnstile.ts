// Verificación server-side de tokens de Cloudflare Turnstile.
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Si TURNSTILE_SECRET no está configurado, NO validamos (modo dev) y devolvemos
// success=true. En prod siempre debe estar para que el endpoint rechace bots.
// Las site keys públicas (test / always-passes) se declaran en wrangler.toml.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifyResult {
  success: boolean;
  /** true si el backend no tenía TURNSTILE_SECRET (modo dev) y se aceptó el token sin chequear. */
  bypassed: boolean;
  /** Mensaje legible si success=false. */
  error?: string;
}

/**
 * Verifica un token de Turnstile contra el endpoint oficial de Cloudflare.
 * @param secret    TURNSTILE_SECRET (de wrangler secret en prod, de .dev.vars en local)
 * @param token     Token entregado por el widget del cliente (campo "cf-turnstile-response")
 * @param remoteIp  IP del cliente (opcional pero recomendado)
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | null | undefined,
  remoteIp?: string | null
): Promise<TurnstileVerifyResult> {
  // Modo dev: sin secret configurado, no validamos.
  // Loggeamos para que sea visible en consola y no se nos pase en prod.
  if (!secret) {
    console.warn(
      '[turnstile] TURNSTILE_SECRET no configurado; se omite la verificación (modo dev).'
    );
    return { success: true, bypassed: true };
  }

  if (!token || typeof token !== 'string' || token.length === 0) {
    return { success: false, bypassed: false, error: 'Falta el token anti-bot.' };
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      return {
        success: false,
        bypassed: false,
        error: `Turnstile rechazó la solicitud (HTTP ${res.status}).`,
      };
    }
    const data = (await res.json()) as {
      success: boolean;
      'error-codes'?: string[];
    };
    if (!data.success) {
      const codes = (data['error-codes'] || []).join(', ') || 'unknown';
      return {
        success: false,
        bypassed: false,
        error: `Verificación anti-bot falló (${codes}).`,
      };
    }
    return { success: true, bypassed: false };
  } catch (err) {
    console.error('[turnstile] verify failed:', err);
    // Si el endpoint de Cloudflare está caído, NO bloqueamos al usuario:
    // sería peor tirar el lead magnet que dejar pasar al bot.
    return { success: true, bypassed: true };
  }
}
