// Island del escáner (vanilla JS, sin framework). Maneja submit, loading por
// pasos, render del resultado y el gating (teaser → desbloqueo con correo).

const ENDPOINT = '/api/scan';
// CTA final → sección de servicios del portafolio. Cambia esta URL si hace falta.
const CTA_URL = 'https://lukasibanez.dev/#servicios';

interface SubScores {
  tecnico: number;
  claridadNegocio: number;
  citabilidad: number;
  autoridad: number;
  claridadGeografica: number;
}
interface ScanResult {
  url: string;
  domain: string;
  scannedAt: string;
  fromCache: boolean;
  finalScore: number;
  verdict: string;
  subScores: SubScores;
  aiAnalysisAvailable: boolean;
  blocksAiBots: boolean;
  recommendationsCount: number;
  technicalSummary: { passed: number; total: number };
  locked: boolean;
  recommendations: string[] | null;
}

const LOAD_STEPS = [
  'Leyendo tu sitio web',
  'Revisando cómo te ven las IA',
  'Analizando tu contenido',
  'Calculando tu puntaje',
];

let lastUrl = '';

function el(tag: string, cls?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function band(score: number): { col: string } {
  if (score >= 70) return { col: 'var(--good)' };
  if (score >= 45) return { col: 'var(--mid)' };
  return { col: 'var(--bad)' };
}

export function initScanner(): void {
  const form = document.getElementById('scan-form') as HTMLFormElement | null;
  const output = document.getElementById('scan-output');
  if (!form || !output) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const url = String(data.get('url') || '').trim();
    const email = String(data.get('email') || '').trim();
    if (!url) {
      showFormError(form, 'Escribe la dirección de tu sitio.');
      return;
    }
    clearFormError(form);
    lastUrl = url;
    await runScan(output, { url, email: email || undefined });
  });
}

async function runScan(output: HTMLElement, body: { url: string; email?: string }): Promise<void> {
  const btn = document.getElementById('scan-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const stopLoading = renderLoading(output);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as ScanResult | { error?: string } | null;
    stopLoading();

    if (!res.ok) {
      const msg = (json && 'error' in json && json.error) || 'Algo salió mal. Inténtalo de nuevo en un momento.';
      renderError(output, msg);
      return;
    }
    renderResult(output, json as ScanResult);
    output.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    stopLoading();
    renderError(output, 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderLoading(output: HTMLElement): () => void {
  output.innerHTML = '';
  const box = el('div', 'loading card');
  box.appendChild(el('div', 'spinner'));
  const title = el('p');
  title.style.fontWeight = '700';
  title.textContent = 'Escaneando tu sitio…';
  box.appendChild(title);

  const ul = el('ul', 'load-steps');
  const lis = LOAD_STEPS.map((label, i) => {
    const li = el('li');
    li.appendChild(el('span', 'tick'));
    li.appendChild(document.createTextNode(label));
    if (i === 0) li.classList.add('active');
    ul.appendChild(li);
    return li;
  });
  box.appendChild(ul);
  output.appendChild(box);
  output.hidden = false;

  let idx = 0;
  const timer = window.setInterval(() => {
    if (idx < lis.length - 1) {
      lis[idx].classList.replace('active', 'done');
      idx++;
      lis[idx].classList.add('active');
    }
  }, 1300);
  return () => window.clearInterval(timer);
}

function renderError(output: HTMLElement, message: string): void {
  output.innerHTML = '';
  const box = el('div', 'loading card');
  const p = el('p');
  p.style.color = '#8f2a2d';
  p.style.fontWeight = '600';
  p.textContent = message;
  box.appendChild(p);
  output.appendChild(box);
  output.hidden = false;
}

function subscoreRow(label: string, val: number): HTMLElement {
  const row = el('div', 'subscore');
  const l = el('span', 'label');
  l.textContent = label;
  const v = el('span', 'val');
  v.textContent = `${val}/100`;
  const bar = el('div', 'bar');
  const span = document.createElement('span');
  span.dataset.w = String(Math.max(0, Math.min(100, val)));
  bar.appendChild(span);
  row.appendChild(l);
  row.appendChild(v);
  row.appendChild(bar);
  return row;
}

function renderResult(output: HTMLElement, r: ScanResult): void {
  output.innerHTML = '';
  const card = el('div', 'result card');

  // --- Puntaje + veredicto ---
  const top = el('div', 'result-top');
  const ring = el('div', 'score-ring');
  const b = band(r.finalScore);
  ring.style.setProperty('--ring', b.col);
  const inner = el('div', 'inner');
  const num = el('div', 'num');
  num.textContent = String(r.finalScore);
  num.style.color = b.col;
  const den = el('div', 'den');
  den.textContent = 'de 100';
  inner.appendChild(num);
  inner.appendChild(den);
  ring.appendChild(inner);
  top.appendChild(ring);

  const verdict = el('div', 'verdict');
  const h2 = el('h2');
  h2.textContent = 'Tu puntaje GEO';
  const vp = el('p');
  vp.textContent = r.verdict;
  verdict.appendChild(h2);
  verdict.appendChild(vp);
  if (r.blocksAiBots) {
    const alert = el('div', 'badge-alert');
    alert.textContent = '⚠ Tu sitio está bloqueando a los robots de IA.';
    verdict.appendChild(alert);
  }
  top.appendChild(verdict);
  card.appendChild(top);
  requestAnimationFrame(() => ring.style.setProperty('--pct', String(r.finalScore)));

  // --- Subscores ---
  const subs = el('div', 'subscores');
  const items: Array<[string, number, boolean]> = [
    ['Preparación técnica', r.subScores.tecnico, true],
    ['Claridad del negocio', r.subScores.claridadNegocio, r.aiAnalysisAvailable],
    ['Facilidad para ser citado', r.subScores.citabilidad, r.aiAnalysisAvailable],
    ['Señales de autoridad', r.subScores.autoridad, r.aiAnalysisAvailable],
    ['Claridad geográfica', r.subScores.claridadGeografica, r.aiAnalysisAvailable],
  ];
  for (const [label, val, show] of items) {
    if (show) subs.appendChild(subscoreRow(label, val));
  }
  card.appendChild(subs);

  if (!r.aiAnalysisAvailable) {
    const note = el('p', 'meta-note');
    note.textContent =
      'El análisis de contenido con IA no estuvo disponible en este momento; te mostramos tu puntaje técnico. Vuelve a intentarlo más tarde para el análisis completo.';
    card.appendChild(note);
  }

  // --- Recomendaciones (full) o desbloqueo (teaser) ---
  if (!r.locked && r.recommendations && r.recommendations.length) {
    const title = el('h3', 'section-title');
    title.textContent = 'Qué mejorar (en orden de impacto)';
    card.appendChild(title);
    const recs = el('div', 'recs');
    r.recommendations.forEach((text, i) => {
      const rec = el('div', 'rec');
      const ico = el('div', 'ico');
      ico.textContent = String(i + 1);
      const p = el('p');
      p.textContent = text;
      rec.appendChild(ico);
      rec.appendChild(p);
      recs.appendChild(rec);
    });
    card.appendChild(recs);
  } else if (r.locked) {
    card.appendChild(renderUnlock(output, r));
  }

  card.appendChild(renderCta());

  const meta = el('p', 'meta-note');
  meta.textContent = `Escaneo de ${r.domain}${r.fromCache ? ' · resultado reciente (en caché)' : ''}.`;
  card.appendChild(meta);

  output.appendChild(card);
  output.hidden = false;

  requestAnimationFrame(() => {
    card.querySelectorAll<HTMLElement>('.bar > span').forEach((s) => {
      s.style.width = (s.dataset.w || '0') + '%';
    });
  });
}

function renderUnlock(output: HTMLElement, r: ScanResult): HTMLElement {
  const box = el('div', 'unlock');
  const h = el('h3');
  h.textContent = 'Desbloquea tus recomendaciones';
  const p = el('p');
  const count = el('span', 'locked-count');
  count.textContent = String(r.recommendationsCount);
  p.appendChild(document.createTextNode('Detectamos '));
  p.appendChild(count);
  p.appendChild(
    document.createTextNode(' mejoras concretas para tu sitio. Déjanos tu correo y te las mostramos al instante.')
  );
  box.appendChild(h);
  box.appendChild(p);

  const form = el('form', 'unlock-form') as HTMLFormElement;
  const input = document.createElement('input');
  input.type = 'email';
  input.required = true;
  input.name = 'email';
  input.autocomplete = 'email';
  input.placeholder = 'tucorreo@ejemplo.com';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Ver mis mejoras';
  form.appendChild(input);
  form.appendChild(btn);

  const err = el('p', 'form-error');
  err.hidden = true;
  err.style.marginTop = '10px';

  box.appendChild(form);
  box.appendChild(err);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = input.value.trim();
    if (!email) {
      err.hidden = false;
      err.textContent = 'Escribe tu correo.';
      return;
    }
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Desbloqueando…';
    await runScan(output, { url: lastUrl, email });
  });

  return box;
}

function renderCta(): HTMLElement {
  const box = el('div', 'cta');
  const h = el('h2');
  h.textContent = '¿Quieres que implementemos estas mejoras por ti?';
  const p = el('p');
  p.textContent =
    'Optimizamos tu sitio para que las IA te encuentren, te entiendan y te recomienden. Tú te concentras en tu negocio.';
  const a = document.createElement('a');
  a.href = CTA_URL;
  a.className = 'btn btn-primary';
  a.textContent = 'Quiero que lo hagan por mí';
  box.appendChild(h);
  box.appendChild(p);
  box.appendChild(a);
  return box;
}

function showFormError(form: HTMLFormElement, message: string): void {
  const e = form.querySelector('#form-error') as HTMLElement | null;
  if (e) {
    e.textContent = message;
    e.hidden = false;
  }
}

function clearFormError(form: HTMLFormElement): void {
  const e = form.querySelector('#form-error') as HTMLElement | null;
  if (e) {
    e.hidden = true;
    e.textContent = '';
  }
}
