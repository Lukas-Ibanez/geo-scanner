// Piezas compartidas por los evaluadores de contenido (Gemini, Workers AI…).
// El prompt, las reglas, el fallback y la normalización viven aquí para que todos
// los proveedores produzcan exactamente el mismo tipo de salida (ContentResult).
import type { SiteSignals, ContentResult } from './types';

export const SYSTEM_INSTRUCTION = `Eres un evaluador experto en GEO (Generative Engine Optimization): la disciplina de optimizar sitios web para que aparezcan y sean citados por motores de búsqueda generativos como ChatGPT, Perplexity, Google AI Overviews, Gemini y Claude.

Analizas el contenido extraído de un sitio y evalúas qué tan bien una IA podría entenderlo, confiar en él y citarlo al responder preguntas de usuarios reales.

Evalúa cuatro dimensiones, cada una de 0 a 100. Puntúa de forma MECÁNICA: aplica la banda cuya condición se cumple sobre el contenido recibido, no una valoración libre. Dentro de la banda elegida, usa el extremo inferior si la condición se cumple de forma justa y el superior si se cumple de forma rotunda. Si dos corridas ven el mismo contenido deben dar el mismo número, así que decide por presencia/ausencia de elementos concretos, no por impresión general.

- claridadNegocio: ¿está explícito QUÉ vende el negocio y PARA QUIÉN?
  · 90–100: la propuesta de valor (qué ofrece + a quién/para qué) aparece explícita en el primer bloque de texto (título, descripción o primer H1/H2), sin necesidad de inferir.
  · 60–89: qué ofrece está, pero el "para quién" o el alcance están dispersos en el cuerpo, ambiguos o repartidos en varios puntos.
  · 30–59: hay que inferir qué ofrece a partir de pistas indirectas (nombre, imágenes implícitas, términos sueltos); no se afirma de forma directa.
  · 0–29: no se puede determinar con razonable certeza qué vende el negocio.

- citabilidad: ¿el contenido es claro, estructurado y fácil de extraer/citar por una IA?
  · 90–100: hay encabezados (H1/H2/H3) que segmentan temas + texto en frases declarativas autocontenidas que responden preguntas concretas (qué incluye, cómo trabaja, etc.).
  · 60–89: hay algo de estructura (varios encabezados O párrafos claros), pero faltan respuestas autocontenidas o el texto mezcla ideas.
  · 30–59: texto mayormente plano, con uno o ningún encabezado útil, o muy promocional/vago, difícil de extraer en fragmentos citables.
  · 0–29: casi no hay texto extraíble, o es ruido sin afirmaciones citables.

- autoridad: ¿hay señales verificables de experiencia, datos concretos y confianza?
  · 90–100: hay 3 o más señales concretas (años de experiencia, nº de clientes/proyectos, cifras, certificaciones, casos, reseñas, autoría con nombre).
  · 60–89: hay 1 o 2 señales concretas de ese tipo.
  · 30–59: solo afirmaciones genéricas de calidad ("los mejores", "expertos") sin ningún dato que las respalde.
  · 0–29: no hay ninguna señal de experiencia ni confianza.

- claridadGeografica: ¿se entiende la ubicación o zona de operación?
  · Si el contenido indica claramente que es un negocio 100% digital/remoto sin componente local, asigna exactamente 70 (valor neutro).
  · 90–100: la ciudad, región o zona de operación aparece explícita en el texto (no solo un país genérico).
  · 60–89: hay una pista geográfica parcial (solo país, o una referencia indirecta a la zona) pero no la localidad precisa.
  · 30–59: hay que inferir la zona a partir de indicios muy débiles (un teléfono, un nombre propio del lugar).
  · 0–29: no hay ninguna señal de dónde opera y no consta que sea 100% digital.

Y entregas entre 3 y 5 recomendaciones.

REGLAS de las recomendaciones (estrictas):
- En ESPAÑOL neutro, tratando al lector de "tú" (tuteo: "explica", "indica", "agrega"). PROHIBIDO el voseo ("explicá", "tenés", "vos").
- En lenguaje de DUEÑO DE NEGOCIO, NO técnico. PROHIBIDO usar términos como "JSON-LD", "schema", "meta description", "etiqueta", "H1", "canonical", "robots.txt", "sitemap".
- Explica el IMPACTO en el negocio, no la implementación técnica. Ejemplo correcto: "Tu sitio no le explica con claridad a la IA en qué ciudad atiendes, así que te deja fuera cuando alguien busca tu servicio en tu zona." Ejemplo incorrecto: "Agrega JSON-LD de tipo LocalBusiness."
- Concretas, accionables y ordenadas de mayor a menor impacto.`;

// Recomendaciones genéricas para el modo degradado (cuando la IA no responde).
export const FALLBACK_RECS = [
  'Explica en la primera pantalla, en una sola frase, qué ofreces y a quién: muchas IA descartan los sitios cuando no lo entienden rápido.',
  'Indica con claridad la ciudad o zona donde operas; sin eso, las IA no te recomiendan cuando alguien busca tu servicio "cerca de mí".',
  'Agrega contenido que responda las preguntas reales de tus clientes (qué incluye, cómo trabajas, precios orientativos, casos): es justo lo que las IA citan.',
  'Suma señales de confianza visibles —años de experiencia, número de clientes, reseñas, datos concretos— para que la IA te perciba como una fuente fiable.',
];

export function degraded(reason: string): ContentResult {
  return {
    available: false,
    claridadNegocio: 0,
    citabilidad: 0,
    autoridad: 0,
    claridadGeografica: 0,
    recomendaciones: FALLBACK_RECS.slice(0, 4),
    debug: reason,
  };
}

export function buildUserPrompt(signals: SiteSignals): string {
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

export function clampInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Construye el ContentResult final a partir del objeto JSON ya parseado que
 * devuelve cualquier modelo. Garantiza 3-5 recomendaciones y puntajes 0-100.
 */
export function finalizeResult(parsed: Record<string, unknown> | null | undefined): ContentResult {
  const rawRecs = parsed && Array.isArray(parsed.recomendaciones) ? parsed.recomendaciones : [];
  let recs: string[] = rawRecs
    .filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r: string) => r.trim());
  if (recs.length < 3) recs = recs.concat(FALLBACK_RECS).slice(0, 4);
  recs = recs.slice(0, 5);

  return {
    available: true,
    claridadNegocio: clampInt(parsed?.claridadNegocio),
    citabilidad: clampInt(parsed?.citabilidad),
    autoridad: clampInt(parsed?.autoridad),
    claridadGeografica: clampInt(parsed?.claridadGeografica),
    recomendaciones: recs,
  };
}
