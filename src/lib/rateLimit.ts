// Rate limiting simple por IP usando Cloudflare KV.
// KV es eventualmente consistente, así que el conteo es aproximado: suficiente
// como freno anti-abuso de un lead magnet (no es un limitador estricto).
//
// Opcionalmente acepta un `namespace` para tener contadores separados en el
// mismo KV (ej. "scan" vs "passphrase-check"). Si no se pasa, usa "scan".

const DEFAULT_NAMESPACE = 'scan';
const GLOBAL_PREFIX = 'rl:';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  limitPerHour: number,
  namespace: string = DEFAULT_NAMESPACE
): Promise<RateLimitResult> {
  const key = `${GLOBAL_PREFIX}${namespace}:${ip}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    // Si KV falla en la lectura, no bloqueamos al usuario.
    return { allowed: true, remaining: limitPerHour };
  }

  if (count >= limitPerHour) return { allowed: false, remaining: 0 };

  try {
    await kv.put(key, String(count + 1), { expirationTtl: 3600 });
  } catch {
    // best-effort
  }
  return { allowed: true, remaining: Math.max(0, limitPerHour - count - 1) };
}
