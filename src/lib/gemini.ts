// Evaluación de contenido con Gemini Flash vía API REST + structured output.
// NO usa el SDK de Node: fetch directo al endpoint REST.
import type { SiteSignals, ContentResult } from './types';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 15000;

const SYSTEM_INSTRUCTION = `Eres un evaluador experto en GEO (Generative Engine Optimization): la disciplina de optimizar sitios web para que aparezcan y sean citados por motores de búsqueda generativos como ChatGPT, Perplexity, Google AI Overviews, Gemini y Claude.

Analizas el contenido extraído de un sitio y evalúas qué tan bien una IA podría entenderlo, confiar en él y citarlo al responder preguntas de usuarios reales.

Evalúa cuatro dimensiones, cada una de 0 a 100:
- claridadNegocio: ¿está claro QUÉ ofrece el negocio y a quién?
- citabilidad: ¿el contenido es claro, estructurado y fácil de citar por una IA?
- autoridad: ¿hay señales de experiencia, datos concretos y confianza?
- claridadGeografica: ¿se entiende la ubicación o zona de operación? Si claramente es un negocio 100% digital sin componente local, asigna un valor neutro cercano a 70.

Y entregas entre 3 y 5 recomendaciones.

REGLAS de las recomendaciones (estrictas):
- En ESPAÑOL.
- En lenguaje de DUEÑO DE NEGOCIO, NO técnico. PROHIBIDO usar términos como "JSON-LD", "schema", "meta description", "etiqueta", "H1", "canonical", "robots.txt", "sitemap".
- Explica el IMPACTO en el negocio, no la implementación técnica. Ejemplo correcto: "Tu sitio no le explica con claridad a la IA en qué ciudad atiendes, así que te deja fuera cuando alguien busca tu servicio en tu zona." Ejemplo incorrecto: "Agrega JSON-LD de tipo LocalBusiness."
- Concretas, accionables y ordenadas de mayor a menor impacto.`;

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

// Recomendaciones genéricas para el modo degradado (cuando la IA no responde).
const FALLBACK_RECS = [
  'Explica en la primera pantalla, en una sola frase, qué ofreces y a quién: muchas IA descartan los sitios cuando no lo entienden rápido.',
  'Indica con claridad la ciudad o zona donde operas; sin eso, las IA no te recomiendan cuando alguien busca tu servicio "cerca de mí".',
  'Agrega contenido que responda las preguntas reales de tus clientes (qué incluye, cómo trabajas, precios orientativos, casos): es justo lo que las IA citan.',
  'Suma señales de confianza visibles —años de experiencia, número de clientes, reseñas, datos concretos— para que la IA te perciba como una fuente fiable.',
];

function degraded(): ContentResult {
  return {
    available: false,
    claridadNegocio: 0,
    citabilidad: 0,
    autoridad: 0,
    claridadGeografica: 0,
    recomendaciones: FALLBACK_RECS.slice(0, 4),
  };
}

function buildUserPrompt(signals: SiteSignals): string {
  return [
    `Idioma declarado del sitio: ${signals.lang || 'desconocido'}`,
    `Título: ${signals.title || '(ninguno)'}`,
    `Descripción: ${signals.metaDescription || '(ninguna)'}`,
    `Encabezados principales (H1): ${signals.h1.join(' | ') || '(ninguno)'}`,
    `Subtítulos (H2): ${signals.h2.slice(0, 15).join(' | ') || '(ninguno)'}`,
    `Subtítulos (H3): ${signals.h3.slice(0, 15).join(' | ') || '(ninguno)'}`,
    `Tipos de datos estructurados detectados: ${signals.jsonLdTypes.join(', ') || '(ninguno)'}`,
    '',
    'Texto visible principal del sitio (extracto):',
    signals.mainText || '(no se pudo extraer texto del sitio)',
  ].join('\n');
}

function clampInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function evaluateContent(signals: SiteSignals, env: Env): Promise<ContentResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return degraded();
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(signals) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
      maxOutputTokens: 1024,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
    if (!res.ok) return degraded();

    const data = (await res.json()) as any;
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return degraded();

    const parsed = JSON.parse(text);
    let recs: string[] = Array.isArray(parsed.recomendaciones)
      ? parsed.recomendaciones
          .filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
          .map((r: string) => r.trim())
      : [];
    if (recs.length < 3) recs = recs.concat(FALLBACK_RECS).slice(0, 4);
    recs = recs.slice(0, 5);

    return {
      available: true,
      claridadNegocio: clampInt(parsed.claridadNegocio),
      citabilidad: clampInt(parsed.citabilidad),
      autoridad: clampInt(parsed.autoridad),
      claridadGeografica: clampInt(parsed.claridadGeografica),
      recomendaciones: recs,
    };
  } catch {
    return degraded();
  } finally {
    clearTimeout(timer);
  }
}
