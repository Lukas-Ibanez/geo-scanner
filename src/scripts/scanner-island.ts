// Island del escáner (vanilla JS, sin framework). Maneja submit, loading por
// pasos, render del resultado (gauge SVG animado) y el gating (teaser → desbloqueo).

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
let lastEmail = '';

function el(tag: string, cls?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function band(score: number): string {
  if (score >= 70) return 'var(--good)';
  if (score >= 45) return 'var(--mid)';
  return 'var(--bad)';
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
    lastEmail = email;
    await runScan(output, { url, email: email || undefined });
  });
}

async function runScan(
  output: HTMLElement,
  body: { url: string; email?: string },
  opts: { unlock?: boolean } = {}
): Promise<void> {
  const btn = document.getElementById('scan-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  // En el paso de desbloqueo NO mostramos la animación de escaneo (confunde: parece
  // que vuelve a escanear). Mantenemos el resultado en pantalla; el botón del
  // formulario ya indica "Enviando…" mientras se procesa.
  const stopLoading = opts.unlock ? () => {} : renderLoading(output);

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
  const title = el('p', 'loading-title');
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
  p.style.color = '#9a2b2b';
  p.style.fontWeight = '600';
  p.textContent = message;
  box.appendChild(p);
  output.appendChild(box);
  output.hidden = false;
}

function animateNumber(node: HTMLElement, to: number, dur: number): void {
  const start = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / dur);
    node.textContent = String(Math.round(p * to));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function buildGauge(score: number, color: string): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const size = 200;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;

  const wrap = el('div', 'gauge');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'gauge-svg');

  const mk = (cls: string) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(size / 2));
    c.setAttribute('cy', String(size / 2));
    c.setAttribute('r', String(r));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', String(stroke));
    c.setAttribute('class', cls);
    return c;
  };

  const track = mk('gauge-track');
  const prog = mk('gauge-prog');
  prog.setAttribute('stroke-linecap', 'round');
  prog.setAttribute('stroke', color);
  prog.style.strokeDasharray = String(circ);
  prog.style.strokeDashoffset = String(circ);
  svg.appendChild(track);
  svg.appendChild(prog);

  const center = el('div', 'gauge-center');
  const num = el('div', 'gauge-num');
  num.style.color = color;
  num.textContent = '0';
  const den = el('div', 'gauge-den');
  den.textContent = '/ 100';
  center.appendChild(num);
  center.appendChild(den);

  wrap.appendChild(svg);
  wrap.appendChild(center);

  requestAnimationFrame(() => {
    prog.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)';
    prog.style.strokeDashoffset = String(circ * (1 - Math.max(0, Math.min(100, score)) / 100));
    animateNumber(num, score, 1100);
  });
  return wrap;
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
  const card = el('div', 'result-card card');
  const color = band(r.finalScore);

  // --- Cabecera: gauge + veredicto ---
  const head = el('div', 'result-head');
  head.appendChild(buildGauge(r.finalScore, color));

  const verdict = el('div', 'verdict');
  const eyebrow = el('div', 'verdict-eyebrow');
  eyebrow.textContent = 'Tu puntaje GEO';
  const vtext = el('p', 'verdict-text');
  vtext.textContent = r.verdict;
  verdict.appendChild(eyebrow);
  verdict.appendChild(vtext);
  if (r.blocksAiBots) {
    const alert = el('div', 'badge-alert');
    alert.textContent = '⚠ Tu sitio está bloqueando a los robots de IA.';
    verdict.appendChild(alert);
  }
  head.appendChild(verdict);
  card.appendChild(head);

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
    const note = el('p', 'ai-note');
    note.textContent =
      'El análisis de contenido con IA no estuvo disponible en este momento; te mostramos tu puntaje técnico. Vuelve a intentarlo más tarde para el análisis completo.';
    card.appendChild(note);
  }

  // --- Recomendaciones (full) o desbloqueo (teaser) ---
  if (!r.locked && r.recommendations && r.recommendations.length) {
    if (lastEmail) {
      const sent = el('div', 'sent-note');
      sent.textContent = `✓ Te enviamos el informe detallado a ${lastEmail}.`;
      card.appendChild(sent);
    }
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

  const meta = el('p', 'result-meta');
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
  h.textContent = 'Recibe tu informe completo';
  const p = el('p');
  const count = el('span', 'locked-count');
  count.textContent = String(r.recommendationsCount);
  p.appendChild(document.createTextNode('Detectamos '));
  p.appendChild(count);
  p.appendChild(
    document.createTextNode(
      ' mejoras concretas para tu sitio. Déjame tu correo: aquí verás el resumen al instante y te envío el informe detallado (diagnóstico técnico punto por punto y plan priorizado) a tu correo.'
    )
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
  btn.textContent = 'Enviarme el informe';
  form.appendChild(input);
  form.appendChild(btn);

  const err = el('p', 'form-error');
  err.hidden = true;
  err.style.marginTop = '12px';

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
    btn.textContent = 'Enviando…';
    lastEmail = email;
    await runScan(output, { url: lastUrl, email }, { unlock: true });
  });

  return box;
}

function renderCta(): HTMLElement {
  const box = el('div', 'cta');
  const h = el('h2');
  h.textContent = '¿Quieres que lo implemente por ti? Hablemos';
  const p = el('p');
  p.textContent =
    'Optimizo tu sitio para que las IA te encuentren, te entiendan y te recomienden. Tú te concentras en tu negocio.';
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
