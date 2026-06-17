// Extracción de señales del HTML.
// - Señales estructuradas (title, headings, meta, JSON-LD, lang): HTMLRewriter
//   nativo de Workers (streaming, liviano).
// - Texto visible principal: extracción por regex sobre el HTML completo. Antes
//   se usaba un handler de texto sobre '*'/'body' con un contador skipDepth, pero
//   en HTMLRewriter los handlers de texto solo reciben el texto INMEDIATO del
//   elemento (y '*' no captura), así que mainText salía SIEMPRE vacío y la IA
//   recibía el sitio "sin contenido". El regex de una sola pasada es robusto para
//   sitios arbitrarios y barato (el HTML ya viene capado a ~800 KB por fetchSite).
import type { SiteSignals } from './types';

// Interfaces mínimas para anotar los handlers sin chocar con el tipo global
// `Element`/`Text` del lib DOM (que Astro incluye para el código de cliente).
interface RWElement {
  getAttribute(name: string): string | null;
  onEndTag(handler: () => void): void;
}
interface RWText {
  text: string;
  lastInTextNode: boolean;
}

const MAX_CHARS = 18000; // ~3.000 palabras; acota lo que se le manda a la IA.

/** Decodifica las entidades HTML más comunes (suficiente para texto de análisis). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    });
}

/** Texto visible del <body>, sin head/script/style/svg/etc. */
function extractVisibleText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|svg|noscript|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

export async function parseHtml(html: string): Promise<SiteSignals> {
  const signals: SiteSignals = {
    title: null,
    metaDescription: null,
    h1: [],
    h2: [],
    h3: [],
    hasJsonLd: false,
    jsonLdTypes: [],
    ogTitle: null,
    ogDescription: null,
    canonical: null,
    lang: null,
    mainText: '',
    wordCount: 0,
  };

  // Factory de handler para encabezados (h1/h2/h3) con buffer por elemento.
  const headingHandler = (target: string[]) => {
    let buf = '';
    return {
      element(el: RWElement) {
        buf = '';
        el.onEndTag(() => {
          const s = buf.replace(/\s+/g, ' ').trim();
          if (s) target.push(s);
        });
      },
      text(t: RWText) {
        buf += t.text;
      },
    };
  };

  let titleBuf = '';
  let ldBuf = '';
  let inLd = false;

  const rw = new HTMLRewriter()
    .on('html', {
      element(el: RWElement) {
        const lang = el.getAttribute('lang');
        if (lang && !signals.lang) signals.lang = lang.trim();
      },
    })
    .on('title', {
      element(el: RWElement) {
        titleBuf = '';
        el.onEndTag(() => {
          signals.title = titleBuf.replace(/\s+/g, ' ').trim() || null;
        });
      },
      text(t: RWText) {
        titleBuf += t.text;
      },
    })
    .on('meta', {
      element(el: RWElement) {
        const name = (el.getAttribute('name') || '').toLowerCase();
        const prop = (el.getAttribute('property') || '').toLowerCase();
        const content = el.getAttribute('content');
        if (!content) return;
        if (name === 'description' && !signals.metaDescription) signals.metaDescription = content.trim();
        if (prop === 'og:title' && !signals.ogTitle) signals.ogTitle = content.trim();
        if (prop === 'og:description' && !signals.ogDescription) signals.ogDescription = content.trim();
      },
    })
    .on('link', {
      element(el: RWElement) {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel.split(/\s+/).includes('canonical')) {
          const href = el.getAttribute('href');
          if (href && !signals.canonical) signals.canonical = href.trim();
        }
      },
    })
    .on('h1', headingHandler(signals.h1))
    .on('h2', headingHandler(signals.h2))
    .on('h3', headingHandler(signals.h3))
    .on('script', {
      element(el: RWElement) {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'application/ld+json') {
          inLd = true;
          ldBuf = '';
          el.onEndTag(() => {
            signals.hasJsonLd = true;
            try {
              collectTypes(JSON.parse(ldBuf), signals.jsonLdTypes, 0);
            } catch {
              /* JSON-LD malformado: igual cuenta como presente */
            }
            inLd = false;
          });
        }
      },
      text(t: RWText) {
        if (inLd) ldBuf += t.text;
      },
    });

  // Consumir la respuesta transformada dispara los handlers.
  await rw.transform(new Response(html)).arrayBuffer();

  signals.jsonLdTypes = [...new Set(signals.jsonLdTypes)];
  const text = extractVisibleText(html);
  signals.mainText = text;
  signals.wordCount = text ? (text.match(/\S+/g)?.length ?? 0) : 0;
  return signals;
}

/** Recorre un objeto JSON-LD (incluido @graph y anidados) juntando los @type. */
function collectTypes(node: unknown, out: string[], depth: number): void {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') out.push(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.push(x);
  for (const key of Object.keys(obj)) {
    if (key === '@type') continue;
    const value = obj[key];
    if (value && typeof value === 'object') collectTypes(value, out, depth + 1);
  }
}
