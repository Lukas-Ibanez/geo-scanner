// Extracción de señales del HTML usando HTMLRewriter (nativo de Workers).
// NO usa cheerio ni APIs de Node. Hace streaming parsing (liviano en CPU).
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

const MAX_WORDS = 3000;
const MAX_CHARS = 24000;
// Elementos cuyo texto NO es contenido visible útil (se excluyen de mainText).
const SKIP_TAGS = ['head', 'script', 'style', 'noscript', 'template', 'svg', 'iframe'];

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

  // Acumulación de texto visible con tope de palabras.
  let skipDepth = 0;
  let words = 0;
  const parts: string[] = [];
  const addText = (raw: string) => {
    if (words >= MAX_WORDS) return;
    const cleaned = raw.replace(/\s+/g, ' ');
    if (!cleaned.trim()) return;
    parts.push(cleaned);
    const matched = cleaned.match(/\S+/g);
    if (matched) words += matched.length;
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

  let rw = new HTMLRewriter();

  // Marca regiones no visibles para excluirlas del texto principal.
  for (const tag of SKIP_TAGS) {
    rw = rw.on(tag, {
      element(el: RWElement) {
        skipDepth++;
        el.onEndTag(() => {
          skipDepth = Math.max(0, skipDepth - 1);
        });
      },
    });
  }

  rw = rw
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
    })
    // Recolector general de texto visible (todo nodo de texto no excluido).
    .on('*', {
      text(t: RWText) {
        if (skipDepth > 0) return;
        addText(t.text);
      },
    });

  // Consumir la respuesta transformada dispara los handlers.
  await rw.transform(new Response(html)).arrayBuffer();

  signals.jsonLdTypes = [...new Set(signals.jsonLdTypes)];
  signals.mainText = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  signals.wordCount = words;
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
