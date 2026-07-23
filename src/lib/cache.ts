// Caché de resultados de escaneo por dominio en Cloudflare KV.
import type { ScanResult } from './types';

const PREFIX = 'scan:';
const TOKEN_PREFIX = 'report-token:';

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

// --- Tokens de acceso al reporte detallado ---
// Reemplazan a la passphrase en la URL del PDF. Cada token se genera cuando
// el usuario desbloquea el detallado con la passphrase válida, y se guarda
// con la URL + competidores que quiere ver. /report valida el token en vez
// de pedir la passphrase. La passphrase NUNCA sale del server.
//
// Razón: la passphrase en query string quedaba en logs (browser, server, mail),
// exponía el acceso de pago a cualquiera que viera el correo.
export interface ReportTokenData {
  url: string;
  competitors: string[];
  createdAt: string;
  /**
   * Reporte YA computado en el desbloqueo. /report lo renderiza tal cual, sin
   * regenerar el informe detallado (que cuesta 20-40s: Sonnet + evaluar cada
   * competidor con Claude). Opcional para compatibilidad con tokens viejos.
   */
  result?: ScanResult;
  /** true si el background detailed falló — el token existe pero sin resultado. */
  failed?: boolean;
  /** Motivo del fallo (para mostrar al usuario). */
  failedReason?: string;
}

export async function getReportToken(kv: KVNamespace, token: string): Promise<ReportTokenData | null> {
  try {
    const raw = await kv.get(TOKEN_PREFIX + token);
    if (!raw) return null;
    return JSON.parse(raw) as ReportTokenData;
  } catch {
    return null;
  }
}

export async function putReportToken(
  kv: KVNamespace,
  token: string,
  data: { url: string; competitors: string[]; result?: ScanResult },
  ttlDays: number = 7
): Promise<void> {
  try {
    await kv.put(TOKEN_PREFIX + token, JSON.stringify({ ...data, createdAt: new Date().toISOString() }), {
      // KV exige un mínimo de 60s. 7 días = 604800s.
      expirationTtl: Math.max(60, Math.round(ttlDays * 86400)),
    });
  } catch {
    // best-effort
  }
}
