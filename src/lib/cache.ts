// Caché de resultados de escaneo por dominio en Cloudflare KV.
import type { ScanResult } from './types';

const PREFIX = 'scan:';

export async function getCachedScan(kv: KVNamespace, domain: string): Promise<ScanResult | null> {
  try {
    const raw = await kv.get(PREFIX + domain);
    if (!raw) return null;
    return JSON.parse(raw) as ScanResult;
  } catch {
    return null;
  }
}

export async function putCachedScan(
  kv: KVNamespace,
  domain: string,
  result: ScanResult,
  ttlHours: number
): Promise<void> {
  try {
    // expirationTtl en segundos; KV exige un mínimo de 60.
    await kv.put(PREFIX + domain, JSON.stringify(result), {
      expirationTtl: Math.max(60, Math.round(ttlHours * 3600)),
    });
  } catch {
    // Cachear es best-effort: si KV falla, el escaneo igual se devuelve.
  }
}
