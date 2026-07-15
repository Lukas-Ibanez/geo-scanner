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
//
// FALLBACK: si el Worker no pudo leer el sitio del cliente (orange-to-orange
// desde un Pages Function a otro sitio detrás de Cloudflare), la fetch
// devuelve `ok: false`. En ese caso `signals` viene vacío y delegamos la
// lectura a Gemini usando la herramienta `googleSearch`, que sale del Worker
// y pega a Google Search — eso bypassea el problema de plataforma y sigue
// dejando que la IA haga el trabajo de entender el rubro.
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

// Umbral mínimo de "texto útil". Si el sitio dio < MIN_MAIN_TEXT_CHARS de
// contenido, lo tratamos como no-leído (orange-to-orange, blocked, etc.) y
// caemos al fallback de Google Search en lugar de pasarle HTML en blanco a
// Gemini (que devolvería lista vacía por falta de contexto).
const MIN_MAIN_TEXT_CHARS = 200;

const SYSTEM = `Eres un experto en marketing y análisis de competencia. Dado el contenido de un sitio (o el resultado de buscarlo en Google), identifica entre 5 y 8 competidores REALES del mismo nicho o rubro.

REGLAS:
- SOLO devuelve competidores reales. NO inventes dominios (si dudas, no lo pongas).
- Devuelve el dominio limpio (sin https://, sin www., sin ruta).
- Deben ser competidores del MISMO nicho/rubro. NO incluyas Google, Wikipedia, YouTube, redes sociales, agregadores de reseñas, ni sitios genéricos.
- Si el sitio es de un nicho muy específico, sé valiente: incluye 3-5 competidores aunque no estés 100% seguro de su estado actual. El sistema que te llama hace probe HTTP después para filtrar los que no responden.
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

// Normaliza + dedup + probe en paralelo, manteniendo solo los primeros
// MAX_RETURNED que respondan. Punto único de "finalización" para que las dos
// estrategias (con signals y via search) compartan exactamente la misma lógica.
async function finalizeCandidates(raw: unknown[]): Promise<SuggestedCompetitor[]> {
  // 1) Normaliza y dedup (sin probe) para no gastar un fetch por duplicado.
  const seen = new Set<string>();
  const candidates: SuggestedCompetitor[] = [];
  for (const c of raw as any[]) {
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

  // 2) Probe en paralelo, pero NO destructivo: el probe corre desde el Worker,
  // así que un competidor válido detrás de Cloudflare (orange-to-orange) o que
  // bloquea bots falla el probe aunque exista. Por eso ordenamos los alcanzables
  // primero y RELLENAMOS con el resto hasta MAX_RETURNED, en vez de descartarlos
  // (el reporte ya maneja con gracia los que no se puedan leer). Así el usuario
  // siempre ve una lista útil en vez de una casi vacía.
  const probed = await Promise.all(
    candidates.map(async (c) => ({ c, reachable: (await originFor(c.domain)) !== null }))
  );

  const reachable = probed.filter((p) => p.reachable).map((p) => p.c);
  const unreachable = probed.filter((p) => !p.reachable).map((p) => p.c);
  return [...reachable, ...unreachable].slice(0, MAX_RETURNED);
}

async function suggestFromSignals(
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
  return finalizeCandidates(input.competitors as unknown[]);
}

// Fallback cuando el Worker NO pudo leer el sitio (orange-to-orange, bloqueo de
// bots, etc.): sin `signals`, le damos a Gemini la URL/dominio y dejamos que
// infiera el rubro con su propio conocimiento. Sale del país por el TLD (.cl,
// .ar, etc.) para sesgar hacia competidores del mercado local.
// NO usa googleSearch: el grounding con Google Search tiene cuota aparte y
// devuelve 429 en el free tier, lo que dejaba la sugerencia SIEMPRE vacía.
function countryHint(domain: string): string {
  const tld = domain.split('.').pop() || '';
  const map: Record<string, string> = {
    cl: 'Chile',
    ar: 'Argentina',
    mx: 'México',
    co: 'Colombia',
    pe: 'Perú',
    es: 'España',
    uy: 'Uruguay',
    ec: 'Ecuador',
  };
  return map[tld] ? ` El negocio opera en ${map[tld]} (dominio .${tld}); prioriza competidores de ese mercado.` : '';
}

async function suggestFromUrl(url: string, env: Env): Promise<SuggestedCompetitor[]> {
  const domain = normalizeDomain(url) || url;
  const userPrompt = `No pudimos leer el contenido del sitio directamente. Deduce a qué se dedica a partir de su dirección y de lo que sepas de él.

Sitio: ${url}
Dominio: ${domain}${countryHint(domain)}

Propón entre 5 y 8 competidores REALES del mismo rubro y mercado, con su dominio limpio y una razón corta en lenguaje de negocio. Si no estás seguro del rubro exacto, apuesta por la interpretación más probable del dominio y NO devuelvas una lista vacía.`;

  const input = await callGeminiTool<{ competitors?: unknown }>({
    system: SYSTEM,
    userPrompt,
    responseSchema: RESPONSE_SCHEMA,
    env,
  });

  if (!input || !Array.isArray(input.competitors)) return [];
  return finalizeCandidates(input.competitors as unknown[]);
}

export async function suggestCompetitors(
  input: { signals?: SiteSignals | null; url: string },
  env: Env
): Promise<SuggestedCompetitor[]> {
  // Salida estructurada SIN googleSearch (el grounding da 429 en el free tier
  // y dejaba esto siempre vacío). Si leímos el sitio, usamos su contenido;
  // si no, inferimos el rubro desde la URL/dominio.
  const signals = input.signals ?? null;
  const hasContent = !!signals && (signals.mainText?.length ?? 0) >= MIN_MAIN_TEXT_CHARS;
  return hasContent ? suggestFromSignals(signals as SiteSignals, env) : suggestFromUrl(input.url, env);
}
