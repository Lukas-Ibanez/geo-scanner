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
  if (!res.body) return await res.text().catch(() => '');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (received >= maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        break;
      }
    }
  }
  out += decoder.decode();
  return out;
}

async function fetchText(url: string, timeoutMs: number, maxBytes: number): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    return { ok: false, status: 0, text: '', finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
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
