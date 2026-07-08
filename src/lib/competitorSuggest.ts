// Sugerencia de competidores del mismo nicho usando Gemini Flash Lite.
// Endpoint pensado para alimentar el botón "Detectar competidores con IA" del
// unlock del informe detallado. La idea: leer el sitio del cliente (ya tenemos
// signals), pasárselo a Gemini y devolver 3-5 dominios reales con una razón
// corta en lenguaje de negocio. No inventa sitios genéricos (Google, Wikipedia,
// redes, agregadores).
//
// Esta tarea usa Gemini (NO Claude) porque es solo enumerar dominios con una
// razón corta: la calidad que da Gemini Flash Lite alcanza de sobra y nos
// ahorra tokens de Claude para el informe detallado (donde sí importa).
// Antes de devolver, hace un probe HTTP rápido a cada dominio para descartar
// sitios caídos / inexistentes. Eso evita que el usuario vea chips de
// competidores que después van a salir como "no-alcanzable" en el reporte.
import type { SiteSignals } from './types';
import { callGeminiTool } from './gemini';
import { probeReachable } from './fetchSite';

export interface SuggestedCompetitor {
  domain: string;
  reason: string;
}

const SYSTEM = `Eres un experto en marketing y análisis de competencia. Dado el contenido de un sitio, identifica entre 5 y 8 competidores REALES del mismo nicho o rubro.

REGLAS ESTRICTAS:
- SOLO devuelve competidores reales. NO inventes dominios.
- Devuelve el dominio limpio (sin https://, sin www., sin ruta).
- Deben ser competidores del MISMO nicho/rubro. NO incluyas Google, Wikipedia, YouTube, redes sociales, agregadores de reseñas, ni sitios genéricos.
- Prioriza competidores que sepas que están activos y operativos. Evita dominios que parezcan antiguos, parked domains o que no estés seguro de que sigan online.
- Si el sitio es muy de nicho y no hay competidores claros, devuelve 3 o 4 (no rellenes con sitios irrelevantes).
- "reason" debe ser una frase corta en lenguaje de NEGOCIO (qué hace ese competidor y por qué es competencia directa), sin jerga técnica.`;

// Subconjunto OpenAPI 3.0 que Gemini acepta en responseSchema. Tipos en MAYÚSCULA
// (OBJECT/ARRAY/STRING), a diferencia de JSON Schema puro.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    competitors: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          domain: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['domain', 'reason'],
      },
    },
  },
  required: ['competitors'],
};

const TARGET_SUGGESTIONS = 8; // pedimos más para tener buffer tras filtrar por alcanzabilidad
const MAX_RETURNED = 5; // tope duro que ve el usuario

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

// Construye un origin alcanzable a partir del dominio: prueba https primero
// y, si falla, cae a http. Devuelve null si ninguno responde.
async function originFor(domain: string): Promise<string | null> {
  const httpsOrigin = `https://${domain}`;
  if (await probeReachable(httpsOrigin)) return httpsOrigin;
  const httpOrigin = `http://${domain}`;
  if (await probeReachable(httpOrigin)) return httpOrigin;
  return null;
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

Devuelve entre 5 y 8 competidores REALES del mismo nicho con su dominio y razón corta. Prioriza los que sepas que están activos.`;

  const input = await callGeminiTool<{ competitors?: unknown }>({
    system: SYSTEM,
    userPrompt,
    responseSchema: RESPONSE_SCHEMA,
    env,
  });

  if (!input || !Array.isArray(input.competitors)) return [];

  // 1) Normaliza y dedup (sin probe) para no gastar un fetch por duplicado.
  const seen = new Set<string>();
  const candidates: SuggestedCompetitor[] = [];
  for (const c of input.competitors as any[]) {
    if (!c || typeof c.domain !== 'string' || typeof c.reason !== 'string') continue;
    const domain = normalizeDomain(c.domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    const reason = c.reason.trim().slice(0, 140);
    if (!reason) continue;
    candidates.push({ domain, reason });
    if (candidates.length >= TARGET_SUGGESTIONS) break;
  }
  if (!candidates.length) return [];

  // 2) Probe en paralelo: cada dominio se prueba https (y cae a http si hace
  // falta). Mantenemos solo los primeros MAX_RETURNED que respondan.
  const probed = await Promise.all(
    candidates.map(async (c) => ({ c, origin: await originFor(c.domain) }))
  );

  const out: SuggestedCompetitor[] = [];
  for (const { c, origin } of probed) {
    if (!origin) continue; // caído / inexistente / no responde -> fuera
    out.push(c);
    if (out.length >= MAX_RETURNED) break;
  }
  return out;
}