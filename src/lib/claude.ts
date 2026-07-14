// Claude (API de Anthropic) vía REST + tool use. NO usa el SDK de Node
// (@anthropic-ai/sdk): fetch directo al endpoint REST, porque esto corre en
// Workers/workerd. Calca el estilo y el manejo de errores de gemini.ts.
//
// Dos exports:
//   callClaudeTool<T>  → primitiva genérica de bajo nivel (structured output vía
//                        una sola tool). La reusa el informe detallado (detailed.ts).
//   evaluateWithClaude → adaptador de contenido estándar (mismo contrato que Gemini),
//                        construido SOBRE callClaudeTool.
import type { SiteSignals, ContentResult } from './types';
import { SYSTEM_INSTRUCTION, buildUserPrompt, degraded, finalizeResult } from './contentShared';

// Haiku 4.5: el modelo más rápido y económico de Anthropic, suficiente para esta rúbrica.
const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3; // mismo criterio que Gemini: priorizar confiabilidad

// Cuenta las llamadas a Claude por día (UTC) en KV y devuelve false si se
// alcanzó el tope. `limit <= 0` significa sin tope. Si KV falla, no bloquea.
// Clave propia (claude:count:<fecha>) para no mezclarse con el budget de Gemini.
// El tope es global a TODO el gasto en Claude (contenido + informe detallado).
async function withinDailyBudget(kv: KVNamespace, limit: number): Promise<boolean> {
  if (limit <= 0) return true;
  const key = `claude:count:${new Date().toISOString().slice(0, 10)}`;
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

export interface CallClaudeToolArgs {
  system: string;
  userPrompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: object;
  env: Env;
  model?: string;
  /** Tope de tokens de salida. Default 2048; el núcleo premium necesita más. */
  maxTokens?: number;
  /** Timeout por intento en ms. Default 15s; salidas largas de Sonnet toman más. */
  timeoutMs?: number;
}

/**
 * Llamada genérica de bajo nivel a la Messages API de Anthropic forzando salida
 * estructurada vía una única tool. Devuelve el `input` de la tool (tipado como T)
 * o `null` ante cualquier fallo: sin API key, tope diario alcanzado, sin bloque
 * tool_use, o un 4xx no transitorio. Nunca lanza. Replica retries/timeout/budget
 * de gemini.ts. El motivo del fallo se registra (console.warn) para diagnóstico.
 */
export async function callClaudeTool<T>(args: CallClaudeToolArgs): Promise<T | null> {
  const apiKey = args.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`callClaudeTool(${args.toolName}) sin ANTHROPIC_API_KEY`);
    return null;
  }

  // Tope diario global de llamadas a Claude (Claude es de pago: protege el presupuesto).
  const parsedLimit = parseInt(args.env.ANTHROPIC_DAILY_LIMIT ?? '', 10);
  const dailyLimit = Number.isFinite(parsedLimit) ? parsedLimit : 200;
  if (!(await withinDailyBudget(args.env.SCAN_CACHE, dailyLimit))) {
    console.warn(`callClaudeTool(${args.toolName}) tope diario alcanzado`);
    return null;
  }

  const model = args.model || args.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const body = {
    model,
    // El system es estable entre llamadas → cache_control para abaratar (solo cachea
    // si el prefijo supera el mínimo del modelo; si no, es inocuo).
    system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: args.userPrompt }],
    max_tokens: args.maxTokens ?? 2048, // requerido por Anthropic (a diferencia de Gemini)
    temperature: 0, // determinismo; Claude no tiene seed (Haiku 4.5 sí acepta temperature)
    tools: [{ name: args.toolName, description: args.toolDescription, input_schema: args.inputSchema }],
    tool_choice: { type: 'tool', name: args.toolName },
  };

  const url = 'https://api.anthropic.com/v1/messages';
  // Estados transitorios de Anthropic (rate limit/sobrecarga/errores 5xx) → reintentar.
  const TRANSIENT = new Set([429, 500, 502, 503, 504, 529]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastReason = 'unknown';

  const timeoutMs = args.timeoutMs ?? TIMEOUT_MS;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        // El resultado viene como un bloque tool_use dentro de data.content.
        const block = data?.content?.find((b: any) => b.type === 'tool_use');
        clearTimeout(timer);
        if (block?.input) return block.input as T;
        // 200 sin tool_use (raro con tool_choice forzado): no es transitorio → null.
        lastReason = 'no-tool-use:' + (data?.stop_reason ?? '?');
        console.warn(`callClaudeTool(${args.toolName}) ${lastReason}`);
        return null;
      }

      const errText = await res.text().catch(() => '');
      lastReason = 'http-' + res.status + ':' + errText.slice(0, 160);
      // Errores de cliente no transitorios (400 payload, 401 key, 403 permiso) no se reintentan.
      if (!TRANSIENT.has(res.status)) {
        clearTimeout(timer);
        console.warn(`callClaudeTool(${args.toolName}) ${lastReason}`);
        return null;
      }
    } catch (err) {
      lastReason = 'exception:' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      clearTimeout(timer);
    }

    // Backoff antes del siguiente intento ante errores transitorios.
    if (attempt < MAX_ATTEMPTS) await sleep(600 * attempt);
  }

  console.warn(`callClaudeTool(${args.toolName}) agotó reintentos: ${lastReason}`);
  return null;
}

// --- Adaptador de contenido estándar (mismo contrato que Gemini/Workers AI) ---

// Structured output vía tool use: forzamos a Claude a llamar esta tool con el
// esquema exacto que necesitamos (Claude no tiene responseSchema como Gemini).
const CONTENT_TOOL_NAME = 'reportar_evaluacion_geo';
const CONTENT_TOOL_DESCRIPTION = 'Devuelve la evaluación GEO estructurada.';
const CONTENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    claridadNegocio: { type: 'integer', minimum: 0, maximum: 100 },
    citabilidad: { type: 'integer', minimum: 0, maximum: 100 },
    autoridad: { type: 'integer', minimum: 0, maximum: 100 },
    claridadGeografica: { type: 'integer', minimum: 0, maximum: 100 },
    recomendaciones: { type: 'array', items: { type: 'string' } },
  },
  required: ['claridadNegocio', 'citabilidad', 'autoridad', 'claridadGeografica', 'recomendaciones'],
};

export async function evaluateWithClaude(signals: SiteSignals, env: Env): Promise<ContentResult> {
  const input = await callClaudeTool<Record<string, unknown>>({
    system: SYSTEM_INSTRUCTION,
    userPrompt: buildUserPrompt(signals),
    toolName: CONTENT_TOOL_NAME,
    toolDescription: CONTENT_TOOL_DESCRIPTION,
    inputSchema: CONTENT_INPUT_SCHEMA,
    env,
  });
  if (!input) return degraded('claude:sin-respuesta');
  return finalizeResult(input); // finalizeResult ya valida/clampa
}
