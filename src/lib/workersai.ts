// Evaluación de contenido con Cloudflare Workers AI (binding nativo env.AI).
// Usa JSON mode (response_format json_schema) con Llama 3.3 70B.
import type { SiteSignals, ContentResult } from './types';
import { SYSTEM_INSTRUCTION, buildUserPrompt, degraded, finalizeResult } from './contentShared';

// Modelo por defecto: soporta JSON mode y es rápido. Configurable por env.
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// JSON Schema estándar (distinto al subconjunto OpenAPI de Gemini).
const JSON_SCHEMA = {
  type: 'object',
  properties: {
    claridadNegocio: { type: 'number' },
    citabilidad: { type: 'number' },
    autoridad: { type: 'number' },
    claridadGeografica: { type: 'number' },
    recomendaciones: { type: 'array', items: { type: 'string' } },
  },
  required: ['claridadNegocio', 'citabilidad', 'autoridad', 'claridadGeografica', 'recomendaciones'],
};

export async function evaluateWithWorkersAI(signals: SiteSignals, env: Env): Promise<ContentResult> {
  if (!env.AI) return degraded('no-ai-binding');
  const model = env.WORKERSAI_MODEL || DEFAULT_MODEL;

  try {
    const result = (await env.AI.run(model, {
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user', content: buildUserPrompt(signals) },
      ],
      response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
      max_tokens: 1500,
      temperature: 0.4,
    })) as { response?: unknown };

    const raw = result?.response;
    let parsed: Record<string, unknown> | null = null;
    if (raw && typeof raw === 'object') {
      parsed = raw as Record<string, unknown>;
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return degraded('parse-error');
      }
    } else {
      return degraded('empty-response');
    }
    return finalizeResult(parsed);
  } catch (err) {
    return degraded('exception:' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
  }
}
