// Selector del proveedor de IA para el análisis de contenido.
// Cambia el proveedor con la variable de entorno AI_PROVIDER (sin tocar código):
//   AI_PROVIDER=gemini      → Google Gemini Flash (default)
//   AI_PROVIDER=workers-ai  → Cloudflare Workers AI (Llama 3.3 70B)
import type { SiteSignals, ContentResult } from './types';
import { evaluateWithGemini } from './gemini';
import { evaluateWithWorkersAI } from './workersai';

export async function evaluateContent(signals: SiteSignals, env: Env): Promise<ContentResult> {
  const provider = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  if (provider === 'workers-ai' || provider === 'workersai' || provider === 'cf') {
    return evaluateWithWorkersAI(signals, env);
  }
  return evaluateWithGemini(signals, env);
}
