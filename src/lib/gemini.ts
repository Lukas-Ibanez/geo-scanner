// Evaluación de contenido con Gemini Flash vía API REST + structured output.
// NO usa el SDK de Node: fetch directo al endpoint REST.
import type { SiteSignals, ContentResult } from './types';
import { SYSTEM_INSTRUCTION, buildUserPrompt, degraded, finalizeResult } from './contentShared';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3; // Gemini es el único proveedor: priorizamos confiabilidad sobre velocidad

// responseSchema de Gemini (subconjunto de OpenAPI) → fuerza JSON válido.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    claridadNegocio: { type: 'INTEGER' },
    citabilidad: { type: 'INTEGER' },
    autoridad: { type: 'INTEGER' },
    claridadGeografica: { type: 'INTEGER' },
    recomendaciones: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['claridadNegocio', 'citabilidad', 'autoridad', 'claridadGeografica', 'recomendaciones'],
  propertyOrdering: ['claridadNegocio', 'citabilidad', 'autoridad', 'claridadGeografica', 'recomendaciones'],
};

// Cuenta las llamadas a Gemini por día (UTC) en KV y devuelve false si se
// alcanzó el tope. `limit <= 0` significa sin tope. Si KV falla, no bloquea.
async function withinDailyBudget(kv: KVNamespace, limit: number): Promise<boolean> {
  if (limit <= 0) return true;
  const key = `gemini:count:${new Date().toISOString().slice(0, 10)}`;
  try {
    const raw = await kv.get(key);
    const count = raw ? parseInt(raw, 10) || 0 : 0;
    if (count >= limit) return false;
    await kv.put(key, String(count + 1), { expirationTtl: 172800 });
    return true;
  } catch {
    return true;
  }
}

export async function evaluateWithGemini(signals: SiteSignals, env: Env): Promise<ContentResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return degraded('no-api-key');
  }

  // Tope diario global de llamadas a Gemini (protege la cuota gratuita).
  const parsedLimit = parseInt(env.GEMINI_DAILY_LIMIT ?? '', 10);
  const dailyLimit = Number.isFinite(parsedLimit) ? parsedLimit : 200;
  if (!(await withinDailyBudget(env.SCAN_CACHE, dailyLimit))) return degraded('daily-limit');

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(signals) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
      maxOutputTokens: 2048,
      // gemini-2.5-flash "piensa" por defecto y puede gastarse el presupuesto de
      // tokens pensando sin devolver texto. Lo desactivamos para garantizar salida.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  // Estados transitorios de Gemini (sobrecarga/cuota momentánea/timeouts) → reintentar.
  const TRANSIENT = new Set([429, 500, 502, 503, 504]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const candidate = data?.candidates?.[0];
        const text: string | undefined = candidate?.content?.parts?.[0]?.text;
        if (!text) {
          lastReason = 'no-text:' + (candidate?.finishReason ?? '?');
        } else {
          return finalizeResult(JSON.parse(text));
        }
      } else {
        const errText = await res.text().catch(() => '');
        lastReason = 'http-' + res.status + ':' + errText.slice(0, 160);
        // Errores de cliente (400 key/payload, 403 permiso) no se reintentan.
        if (!TRANSIENT.has(res.status)) {
          clearTimeout(timer);
          return degraded(lastReason);
        }
      }
    } catch (err) {
      lastReason = 'exception:' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      clearTimeout(timer);
    }

    // Backoff antes del siguiente intento ante errores transitorios.
    if (attempt < MAX_ATTEMPTS) await sleep(600 * attempt);
  }

  return degraded(lastReason);
}
