// Descarga del HTML del sitio + robots.txt / llms.txt / sitemap.xml en paralelo.
// Solo Web Standard APIs (fetch, AbortController, TextDecoder).
import type { FetchedSite } from './types';

// UA de navegador real: muchos sitios bloquean User-Agents que parecen "robot",
// sobre todo a peticiones desde servidores (las IPs de Cloudflare).
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_TIMEOUT_MS = 8000;
const AUX_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 800_000; // ~800 KB (acota el CPU del parseo en el plan gratis)
const MAX_AUX_BYTES = 200_000;

interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
  finalUrl: string;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  // Antes usábamos getReader() + streaming chunk-by-chunk. Eso hace que el
  // Worker se cuelgue en `reader.read()` cuando hace outbound a un sitio
  // detrás de Cloudflare (orange-to-orange: Worker CF → sitio CF). El
  // Promise.race de más abajo evita el cuelgue total del Worker, pero igual
  // terminaba devolviendo `ok: false` para sitios tipo cyclonemotos.cl.
  //
  // Solución: leer el body completo via arrayBuffer() (que internamente usa
  // un solo read nativo, no streaming) y cortar a maxBytes. La lectura se
  // completa aunque el reader se cuelgue en streaming.
  try {
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    return new TextDecoder('utf-8').decode(slice);
  } catch {
    return await res.text().catch(() => '');
  }
}

const FAILED = (url: string): FetchTextResult => ({ ok: false, status: 0, text: '', finalUrl: url });

async function fetchText(url: string, timeoutMs: number, maxBytes: number): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const work = (async (): Promise<FetchTextResult> => {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await readCapped(res, maxBytes);
      return { ok: res.ok, status: res.status, text, finalUrl: res.url || url };
    } catch {
      return FAILED(url);
    } finally {
      clearTimeout(timer);
    }
  })();

  // Guard duro: si el sitio destino está detrás de Cloudflare (orange-to-orange) o
  // su cuerpo se transmite "goteando", el AbortController puede no cancelar un
  // `reader.read()` colgado y el Worker excedería su tiempo → 502 crudo de la
  // plataforma (se salta nuestro manejo de errores). Este race garantiza que
  // fetchText SIEMPRE resuelva; la promesa colgada se abandona sin esperarla.
  const guard = new Promise<FetchTextResult>((resolve) =>
    setTimeout(() => resolve(FAILED(url)), timeoutMs + 1500)
  );

  return Promise.race([work, guard]);
}

export async function fetchSite(origin: string, url: string): Promise<FetchedSite> {
  const [page, robots, llms, sitemap] = await Promise.all([
    fetchText(url, PAGE_TIMEOUT_MS, MAX_HTML_BYTES),
    fetchText(origin + '/robots.txt', AUX_TIMEOUT_MS, MAX_AUX_BYTES),
    fetchText(origin + '/llms.txt', AUX_TIMEOUT_MS, MAX_AUX_BYTES),
    fetchText(origin + '/sitemap.xml', AUX_TIMEOUT_MS, 50_000),
  ]);

  return {
    ok: page.ok,
    status: page.status,
    html: page.text,
    finalUrl: page.finalUrl,
    robotsTxt: robots.ok && robots.text.trim() ? robots.text : null,
    llmsTxt: llms.ok && llms.text.trim() ? llms.text : null,
    sitemapExists: sitemap.ok && sitemap.text.trim().length > 0,
  };
}

// Probe rápido de alcanzabilidad para filtrar sugerencias de competidores.
// Mucho más liviano que fetchSite (no descarga robots/llms/sitemap ni HTML
// completo): solo intenta un HEAD/GET corto al homepage. Devuelve true si el
// sitio responde con cualquier 2xx/3xx dentro del timeout — eso alcanza para
// confirmar que existe y no nos va a salir "no-alcanzable" en el reporte.
const PROBE_TIMEOUT_MS = 4000;

export async function probeReachable(origin: string): Promise<boolean> {
  // Algunos servidores rechazan HEAD (405) o devuelven falsos 5xx; caemos a
  // GET con el mismo timeout si la primera intentona falla por red/HTTP.
  for (const method of ['HEAD', 'GET'] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(origin, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
      });
      // 2xx (ok) y 3xx (redirects que ya seguimos) cuentan como alcanzable.
      // 4xx (no 405) -> sitio responde pero rechaza / no existe -> no seguimos.
      // 405 (Method Not Allowed) -> el método no aplica, caemos al siguiente
      //   (muchos sitios medianos/chicos no implementan HEAD pero sí GET).
      // 5xx -> probá el otro método.
      if (res.ok || (res.status >= 300 && res.status < 400)) return true;
      if (res.status === 405) continue; // probar el otro método
      if (res.status >= 400 && res.status < 500) return false;
      // 5xx -> probá el otro método.
    } catch {
      // Timeout / DNS / conexión rechazada -> probá el otro método.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}
