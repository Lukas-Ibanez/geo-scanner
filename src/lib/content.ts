// Selector del proveedor de IA para el análisis de contenido.
// Cambia el comportamiento con la variable de entorno AI_PROVIDER (sin tocar código):
//   AI_PROVIDER=hybrid      → Gemini principal; si falla/degrada, respaldo Workers AI (default)
//   AI_PROVIDER=gemini      → solo Google Gemini Flash
//   AI_PROVIDER=workers-ai  → solo Cloudflare Workers AI (Llama 3.3 70B)
//   AI_PROVIDER=claude      → solo Claude (API de Anthropic, structured output vía tool use)
import type { SiteSignals, ContentResult } from './types';
import { evaluateWithGemini } from './gemini';
import { evaluateWithWorkersAI } from './workersai';
import { evaluateWithClaude } from './claude';

export async function evaluateContent(signals: SiteSignals, env: Env): Promise<ContentResult> {
  const provider = (env.AI_PROVIDER || 'hybrid').trim().toLowerCase();

  if (provider === 'gemini') return evaluateWithGemini(signals, env);
  if (provider === 'claude' || provider === 'anthropic') return evaluateWithClaude(signals, env);
  if (provider === 'workers-ai' || provider === 'workersai' || provider === 'cf') {
    return evaluateWithWorkersAI(signals, env);
  }

  // hybrid (default): Gemini da mejores recomendaciones; Workers AI es el respaldo
  // robusto cuando Gemini degrada (cuota 429, timeout, etc.), para no caer nunca
  // al texto genérico mientras haya un proveedor disponible.
  const primary = await evaluateWithGemini(signals, env);
  if (primary.available) return primary;

  const fallback = await evaluateWithWorkersAI(signals, env);
  if (fallback.available) return fallback;

  // Ambos fallaron: devuelve el degradado con el motivo de cada uno.
  return { ...fallback, debug: `gemini:${primary.debug} | workersai:${fallback.debug}` };
}
