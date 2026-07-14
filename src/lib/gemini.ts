// Evaluación de contenido con Gemini Flash vía API REST + structured output.
// NO usa el SDK de Node: fetch directo al endpoint REST.
import type { SiteSignals, ContentResult } from './types';
import { SYSTEM_INSTRUCTION, buildUserPrompt, degraded, finalizeResult } from './contentShared';

// gemini-3.1-flash-lite: 500 req/día en free tier (25× más que 2.5-flash, que solo da 20).
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
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
      // Determinismo máximo: el puntaje se muestra a clientes y debe reproducirse
      // entre escaneos del mismo sitio. temperature 0 + sampling fijo + seed.
      temperature: 0,
      topP: 1,
      topK: 1,
      seed: 42,
      maxOutputTokens: 2048,
      // Solo los modelos 2.x usan `thinkingBudget` (sin esto, 2.5-flash gastaba el
      // presupuesto "pensando" y no devolvía texto). Los 3.x usan `thinkingLevel`
      // y Flash-Lite ya viene en "minimal", así que no necesita configuración.
      ...(model.startsWith('gemini-2') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
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

// --- Primitiva genérica de tool/structured output ---
// Mismo rol que callClaudeTool en claude.ts: el caller pasa un responseSchema
// (subconjunto OpenAPI de Gemini) y recibe el JSON parseado tipado como T, o
// null ante cualquier fallo. Reusa withinDailyBudget + retries + timeout.
// Pensada para tareas que NO son la evaluación de contenido estándar (ej.
// sugerencia de competidores), donde el schema es distinto y el call site
// necesita control total de la forma del output.
export interface CallGeminiToolArgs {
  system: string;
  userPrompt: string;
  responseSchema: object; // subconjunto OpenAPI 3.0 que Gemini acepta en responseSchema
  env: Env;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  tools?: Array<{ googleSearch?: Record<string, never> }>; // herramientas habilitadas (opcional)
}

export async function callGeminiTool<T>(args: CallGeminiToolArgs): Promise<T | null> {
  const apiKey = args.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('callGeminiTool sin GEMINI_API_KEY');
    return null;
  }

  const parsedLimit = parseInt(args.env.GEMINI_DAILY_LIMIT ?? '', 10);
  const dailyLimit = Number.isFinite(parsedLimit) ? parsedLimit : 200;
  if (!(await withinDailyBudget(args.env.SCAN_CACHE, dailyLimit))) {
    console.warn('callGeminiTool tope diario alcanzado');
    return null;
  }

  const model = args.model || args.env.GEMINI_MODEL || DEFAULT_MODEL;

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: args.system }] },
    contents: [{ role: 'user', parts: [{ text: args.userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: args.responseSchema,
      temperature: args.temperature ?? 0,
      topP: 1,
      topK: 1,
      seed: 42,
      maxOutputTokens: args.maxOutputTokens ?? 1024,
      // Mismo criterio que evaluateWithGemini.
      ...(model.startsWith('gemini-2') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  // Tools opcionales (ej. googleSearch para skip el orange-to-orange).
  if (args.tools && args.tools.length) {
    body.tools = args.tools;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
        const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          lastReason = 'no-text:' + (data?.candidates?.[0]?.finishReason ?? '?');
        } else {
          try {
            return JSON.parse(text) as T;
          } catch (e) {
            lastReason = 'parse:' + (e instanceof Error ? e.message : String(e));
          }
        }
      } else {
        const errText = await res.text().catch(() => '');
        lastReason = 'http-' + res.status + ':' + errText.slice(0, 160);
        if (!TRANSIENT.has(res.status)) {
          console.warn(`callGeminiTool fallo no transitorio: ${lastReason}`);
          clearTimeout(timer);
          return null;
        }
      }
    } catch (err) {
      lastReason = 'exception:' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(600 * attempt);
  }

  console.warn(`callGeminiTool fallo tras ${MAX_ATTEMPTS} intentos: ${lastReason}`);
  return null;
}
