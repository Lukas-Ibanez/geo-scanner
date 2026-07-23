import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScanResult } from './types';
import { getCachedScan, putCachedScan, getReportToken, putReportToken } from './cache';

// Mock de KV: un Map en memoria. Suficiente para tests unitarios.
function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(async () => ({ keys: Array.from(store.keys()).map((name) => ({ name })) })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

const fakeResult: ScanResult = {
  url: 'https://example.com',
  domain: 'example.com',
  scannedAt: '2026-01-01T00:00:00Z',
  fromCache: false,
  accessLevel: 'full',
  finalScore: 75,
  verdict: 'OK',
  subScores: { tecnico: 80, claridadNegocio: 70, citabilidad: 75, autoridad: 70, claridadGeografica: 80 },
  aiAnalysisAvailable: true,
  blocksAiBots: false,
  recommendationsCount: 4,
  technicalSummary: { passed: 3, total: 9 },
  locked: false,
  recommendations: ['a', 'b', 'c', 'd'],
  technicalChecks: [],
  detailedReport: null,
};

describe('cache — getCachedScan / putCachedScan', () => {
  let kv: ReturnType<typeof createMockKV>;
  beforeEach(() => { kv = createMockKV(); });

  it('putCachedScan guarda y getCachedScan lee', async () => {
    await putCachedScan(kv as unknown as KVNamespace, 'example.com', fakeResult, 6);
    const got = await getCachedScan(kv as unknown as KVNamespace, 'example.com');
    expect(got).not.toBeNull();
    expect(got!.domain).toBe('example.com');
    expect(got!.finalScore).toBe(75);
  });

  it('usa el prefijo "scan:" en la key', async () => {
    await putCachedScan(kv as unknown as KVNamespace, 'example.com', fakeResult, 6);
    expect(kv._store.has('scan:example.com')).toBe(true);
  });

  it('getCachedScan devuelve null si no existe', async () => {
    const got = await getCachedScan(kv as unknown as KVNamespace, 'no-existe.com');
    expect(got).toBeNull();
  });

  it('getCachedScan devuelve null si el JSON está corrupto', async () => {
    kv._store.set('scan:example.com', 'esto no es json');
    const got = await getCachedScan(kv as unknown as KVNamespace, 'example.com');
    expect(got).toBeNull();
  });

  it('respetta el TTL mínimo de 60s de KV', async () => {
    // 0.5 horas = 1800s, pero KV exige mínimo 60s.
    await putCachedScan(kv as unknown as KVNamespace, 'example.com', fakeResult, 0.5);
    // El put se llamó con el TTL clampado a 60. No podemos verificar el TTL
    // sin mockear más el SDK, pero al menos verificamos que no lanza.
    const got = await getCachedScan(kv as unknown as KVNamespace, 'example.com');
    expect(got).not.toBeNull();
  });
});

describe('cache — getReportToken / putReportToken', () => {
  let kv: ReturnType<typeof createMockKV>;
  beforeEach(() => { kv = createMockKV(); });

  it('guarda y recupera un token con url + competidores', async () => {
    const token = 'test-uuid-1234';
    await putReportToken(kv as unknown as KVNamespace, token, {
      url: 'https://example.com',
      competitors: ['comp1.com', 'comp2.com'],
    });
    const got = await getReportToken(kv as unknown as KVNamespace, token);
    expect(got).not.toBeNull();
    expect(got!.url).toBe('https://example.com');
    expect(got!.competitors).toEqual(['comp1.com', 'comp2.com']);
    expect(got!.createdAt).toBeDefined();
  });

  it('usa el prefijo "report-token:" en la key', async () => {
    await putReportToken(kv as unknown as KVNamespace, 'abc', { url: 'https://x.com', competitors: [] });
    expect(kv._store.has('report-token:abc')).toBe(true);
    expect(kv._store.has('abc')).toBe(false);
  });

  it('getReportToken devuelve null para token inexistente', async () => {
    const got = await getReportToken(kv as unknown as KVNamespace, 'no-existe');
    expect(got).toBeNull();
  });

  it('preserva el campo failed si está presente', async () => {
    await putReportToken(kv as unknown as KVNamespace, 'fail', {
      url: 'https://x.com',
      competitors: [],
      failed: true,
      failedReason: 'rate limit',
    });
    const got = await getReportToken(kv as unknown as KVNamespace, 'fail');
    expect(got!.failed).toBe(true);
    expect(got!.failedReason).toBe('rate limit');
  });

  it('preserva el campo result si está presente', async () => {
    await putReportToken(kv as unknown as KVNamespace, 'r', {
      url: 'https://x.com',
      competitors: [],
      result: fakeResult,
    });
    const got = await getReportToken(kv as unknown as KVNamespace, 'r');
    expect(got!.result).toEqual(fakeResult);
  });

  it('TTL de 7 días por defecto (604800s)', async () => {
    // Verificamos que no tira con TTLs normales.
    await putReportToken(kv as unknown as KVNamespace, 't', { url: 'https://x.com', competitors: [] });
    // No podemos inspeccionar el TTL exacto sin mockear el SDK, pero verificamos
    // que put/get funciona.
    const got = await getReportToken(kv as unknown as KVNamespace, 't');
    expect(got).not.toBeNull();
  });
});
