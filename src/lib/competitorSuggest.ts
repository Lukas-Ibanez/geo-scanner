// Sugerencia de competidores del mismo nicho usando Claude (Haiku 4.5).
// Endpoint pensado para alimentar el botón "Detectar competidores con IA" del
// unlock del informe detallado. La idea: leer el sitio del cliente (ya tenemos
// signals), pasárselo a Claude y devolver 3-5 dominios reales con una razón
// corta en lenguaje de negocio. No inventa sitios genéricos (Google, Wikipedia,
// redes, agregadores).
import type { SiteSignals } from './types';
import { callClaudeTool } from './claude';

export interface SuggestedCompetitor {
  domain: string;
  reason: string;
}

const SYSTEM = `Eres un experto en marketing y análisis de competencia. Dado el contenido de un sitio, identifica entre 3 y 5 competidores REALES del mismo nicho o rubro.

REGLAS ESTRICTAS:
- SOLO devuelve competidores reales. NO inventes dominios.
- Devuelve el dominio limpio (sin https://, sin www., sin ruta).
- Deben ser competidores del MISMO nicho/rubro. NO incluyas Google, Wikipedia, YouTube, redes sociales, agregadores de reseñas, ni sitios genéricos.
- Si el sitio es muy de nicho y no hay competidores claros, devuelve 1 o 2 (no rellenes con sitios irrelevantes).
- "reason" debe ser una frase corta en lenguaje de NEGOCIO (qué hace ese competidor y por qué es competencia directa), sin jerga técnica.`;

const TOOL_NAME = 'sugerir_competidores';
const TOOL_DESCRIPTION =
  'Devuelve hasta 5 competidores reales del mismo rubro que el sitio del cliente.';
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    competitors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['domain', 'reason'],
      },
    },
  },
  required: ['competitors'],
};

// Normaliza a "ejemplo.com" — sin esquema, sin www., sin path. Si queda vacío
// o no parece un dominio, se descarta.
function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split('/')[0];
  d = d.split('?')[0];
  if (!d || !d.includes('.') || /\s/.test(d)) return null;
  return d;
}

export async function suggestCompetitors(
  signals: SiteSignals,
  env: Env
): Promise<SuggestedCompetitor[]> {
  const userPrompt = `Sitio a analizar:
- Título: ${signals.title || '(sin título)'}
- Meta descripción: ${signals.metaDescription || '(sin descripción)'}
- H1 principal: ${signals.h1[0] || '(sin h1)'}
- Idioma: ${signals.lang || 'desconocido'}
- Tipos JSON-LD: ${signals.jsonLdTypes.join(', ') || '(ninguno)'}

Contenido (primeros ~1500 caracteres):
"""
${signals.mainText.slice(0, 1500)}
"""

Devuelve entre 3 y 5 competidores REALES del mismo nicho con su dominio y razón corta.`;

  const input = await callClaudeTool<{ competitors?: unknown }>({
    system: SYSTEM,
    userPrompt,
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    env,
    model: env.DETAILED_MODEL || 'claude-haiku-4-5',
  });

  if (!input || !Array.isArray(input.competitors)) return [];
  const out: SuggestedCompetitor[] = [];
  for (const c of input.competitors as any[]) {
    if (!c || typeof c.domain !== 'string' || typeof c.reason !== 'string') continue;
    const domain = normalizeDomain(c.domain);
    if (!domain) continue;
    const reason = c.reason.trim().slice(0, 140);
    if (!reason) continue;
    out.push({ domain, reason });
    if (out.length >= 5) break;
  }
  return out;
}