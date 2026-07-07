// Island del escáner (vanilla JS, sin framework). Maneja submit, loading por
// pasos, render del resultado (gauge SVG animado), gating (teaser → desbloqueo)
// y Turnstile. Vive SOLO en /scan.

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
// Puntaje (final + subpuntajes) — null si no se pudo evaluar.
interface ScoreSnapshot {
  finalScore: number | null;
  subScores: SubScores | null;
}
// Un competidor evaluado con el MISMO método que el cliente.
interface CompetitorComparison {
  url: string;
  domain: string;
  finalScore: number | null;
  subScores: SubScores | null;
  error?: string;
}
// Pregunta-cliente y si el sitio tiene contenido que la IA pueda citar como respuesta.
interface ClientQuestion {
  pregunta: string;
  cubierta: boolean;
  nota: string;
}
// Informe detallado (nivel 'detailed'): lo que el escaneo gratis no hace.
// Cada sección puede venir null si degradó; se pinta solo lo que llegó.
interface DetailedReport {
  competitors: CompetitorComparison[] | null;
  competitorsSummary: string | null;
  clientComparison: ScoreSnapshot | null;
  clientQuestions: ClientQuestion[] | null;
  generatedAt: string;
}
interface ScanResult {
  url: string;
  domain: string;
  scannedAt: string;
  fromCache: boolean;
  accessLevel: 'teaser' | 'full' | 'detailed';
  finalScore: number;
  verdict: string;
  subScores: SubScores;
  aiAnalysisAvailable: boolean;
  blocksAiBots: boolean;
  recommendationsCount: number;
  technicalSummary: { passed: number; total: number };
  locked: boolean;
  recommendations: string[] | null;
  detailedReport: DetailedReport | null;
}

const LOAD_STEPS = [
  'Leyendo tu sitio web',
  'Revisando cómo te ven las IA',
  'Analizando tu contenido',
  'Calculando tu puntaje',
];

let lastUrl = '';
let lastEmail = '';
// Lo último que se envió al backend (passphrase + competidores) — lo usamos
// para construir el link al reporte PDF cuando el resultado es 'detailed'.
let lastPassphrase = '';
let lastCompetitors: string[] = [];

// --- Estado de Turnstile ---
// El widget entrega el token vía callback global. Lo guardamos acá para
// incluirlo en el POST y para habilitar/deshabilitar el botón.
declare global {
  interface Window {
    onTurnstileSuccess?: (token: string) => void;
    onTurnstileExpired?: () => void;
    onTurnstileError?: () => void;
    onTurnstileLoad?: () => void;
    turnstile?: {
      reset: (widgetId?: string) => void;
    };
  }
}

let turnstileToken: string | null = null;
let turnstileReady = false;

function getTurnstileToken(): string | null {
  // 1) Token guardado por el callback.
  if (turnstileToken) return turnstileToken;
  // 2) Fallback: leer el input que el widget inyecta en el DOM.
  const input = document.querySelector<HTMLInputElement>(
    'input[name="cf-turnstile-response"]'
  );
  return input && input.value ? input.value : null;
}

function setSubmitEnabled(enabled: boolean): void {
  const btn = document.getElementById('scan-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
}

// Callbacks globales que el widget de Turnstile invoca.
// (definidos en window para que Turnstile los encuentre).
window.onTurnstileSuccess = (token: string) => {
  turnstileToken = token;
  // Si la URL ya está escrita, habilitamos el botón.
  const url = (document.getElementById('url') as HTMLInputElement | null)?.value.trim() || '';
  setSubmitEnabled(url.length > 0);
};
window.onTurnstileExpired = () => {
  turnstileToken = null;
  setSubmitEnabled(false);
};
window.onTurnstileError = () => {
  turnstileToken = null;
  setSubmitEnabled(false);
};
window.onTurnstileLoad = () => {
  turnstileReady = true;
  // Si la URL ya está escrita, dejamos el botón listo (esperando token).
  const url = (document.getElementById('url') as HTMLInputElement | null)?.value.trim() || '';
  setSubmitEnabled(url.length > 0 && !!turnstileToken);
};

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

  // El botón arranca deshabilitado hasta tener URL + token de Turnstile.
  setSubmitEnabled(false);

  // Habilitar el botón cuando se escribe una URL (Turnstile sigue siendo requisito).
  const urlInput = document.getElementById('url') as HTMLInputElement | null;
  urlInput?.addEventListener('input', () => {
    const ok = (urlInput.value || '').trim().length > 0 && (turnstileReady ? !!turnstileToken : true);
    setSubmitEnabled(ok);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const url = String(data.get('url') || '').trim();
    const email = String(data.get('email') || '').trim();
    if (!url) {
      showFormError(form, 'Escribe la dirección de tu sitio.');
      return;
    }
    // Si Turnstile ya cargó, exigimos token. Si no, dejamos pasar (modo dev).
    if (turnstileReady) {
      const token = getTurnstileToken();
      if (!token) {
        showFormError(
          form,
          'Esperando la verificación anti-bot. Si no aparece, recarga la página.'
        );
        return;
      }
    }
    clearFormError(form);
    lastUrl = url;
    lastEmail = email;
    await runScan(output, { url, email: email || undefined });
  });
}

async function runScan(
  output: HTMLElement,
  body: { url: string; email?: string; passphrase?: string; competitors?: string[] },
  opts: { unlock?: boolean } = {}
): Promise<void> {
  const btn = document.getElementById('scan-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  // En el paso de desbloqueo NO mostramos la animación de escaneo (confunde: parece
  // que vuelve a escanear). Mantenemos el resultado en pantalla; el botón del
  // formulario ya indica "Enviando…" mientras se procesa.
  const stopLoading = opts.unlock ? () => {} : renderLoading(output);

  // Adjuntamos el token de Turnstile al body (si existe) en el primer submit
  // del escaneo base. En el unlock, el token ya se consumió; dejamos que Turnstile
  // maneje re-emisión si la necesita.
  const fullBody: Record<string, unknown> = { ...body };
  if (!opts.unlock) {
    const token = getTurnstileToken();
    if (token) fullBody['cf-turnstile-response'] = token;
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fullBody),
    });
    const json = (await res.json().catch(() => null)) as ScanResult | { error?: string } | null;
    stopLoading();

    if (!res.ok) {
      let msg = (json && 'error' in json && json.error) || '';
      if (!msg) {
        msg =
          res.status >= 500
            ? 'No pudimos leer este sitio. Puede estar protegido contra lectores automáticos o no estar disponible en este momento. Prueba con otra página.'
            : 'Algo salió mal. Inténtalo de nuevo en un momento.';
      }
      // Si el server rechazó Turnstile, reseteamos el widget para que el usuario
      // pueda reintentar sin recargar la página.
      if (res.status === 403) {
        try {
          window.turnstile?.reset();
        } catch {
          /* noop */
        }
        turnstileToken = null;
      }
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
  // Botón "Intentar de nuevo" — limpia el output y hace scroll al form.
  const retry = el('button', 'btn btn-secondary');
  retry.type = 'button';
  retry.textContent = 'Volver al formulario';
  retry.style.marginTop = '14px';
  retry.addEventListener('click', () => {
    output.hidden = true;
    output.innerHTML = '';
    const form = document.getElementById('scan-form');
    form?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  box.appendChild(retry);
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

    // --- Informe detallado (nivel 'detailed') — solo si la respuesta lo trae ---
    if (r.accessLevel === 'detailed' && r.detailedReport) {
      card.appendChild(renderDetailed(r.detailedReport));
      card.appendChild(renderPdfButton());
    }
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
      ' mejoras concretas para tu sitio. Déjame tu correo y te envío el informe completo a tu correo.'
    )
  );
  box.appendChild(h);
  box.appendChild(p);

  const form = el('form', 'unlock-form') as HTMLFormElement;

  // --- Email (siempre visible) ---
  const input = document.createElement('input');
  input.type = 'email';
  input.required = true;
  input.name = 'email';
  input.autocomplete = 'email';
  input.placeholder = 'tucorreo@ejemplo.com';
  form.appendChild(input);

  // --- Toggle para el informe detallado (passphrase + competidores) ---
  const ppRow = el('div', 'pp-row');
  const ppToggle = document.createElement('input');
  ppToggle.type = 'checkbox';
  ppToggle.id = 'pp-toggle';
  const ppLabel = document.createElement('label');
  ppLabel.htmlFor = 'pp-toggle';
  ppLabel.className = 'pp-toggle-label';
  ppLabel.textContent = 'Tengo código de acceso (informe detallado)';
  ppRow.appendChild(ppToggle);
  ppRow.appendChild(ppLabel);
  form.appendChild(ppRow);

  // --- Caja del detallado (oculta hasta activar el toggle) ---
  const detailedBox = el('div', 'detailed-box');
  detailedBox.hidden = true;

  // Passphrase
  const ppInput = document.createElement('input');
  ppInput.type = 'text';
  ppInput.name = 'passphrase';
  ppInput.id = 'pp-input';
  ppInput.autocomplete = 'off';
  ppInput.spellcheck = false;
  ppInput.placeholder = 'Código de acceso';
  detailedBox.appendChild(ppInput);

  // --- Comparativa con competidores ---
  const compSection = el('div', 'comp-section');
  const compTitle = document.createElement('p');
  compTitle.className = 'comp-title';
  compTitle.textContent = 'Comparar contra competidores';
  compSection.appendChild(compTitle);

  // Botón "Detectar con IA"
  const detectRow = el('div', 'detect-row');
  const detectBtn = document.createElement('button');
  detectBtn.type = 'button';
  detectBtn.className = 'btn btn-secondary btn-sm';
  detectBtn.textContent = 'Detectar competidores con IA';
  detectRow.appendChild(detectBtn);
  const detectHint = el('span', 'detect-hint');
  detectHint.textContent = ' Lee tu sitio y propone 3–5.';
  detectRow.appendChild(detectHint);
  compSection.appendChild(detectRow);

  // Lista de sugerencias (chips con checkbox)
  const suggestionsList = el('div', 'comp-suggestions');
  suggestionsList.hidden = true;
  compSection.appendChild(suggestionsList);

  // Textarea para URLs manuales
  const compLabel = document.createElement('label');
  compLabel.htmlFor = 'comp-input';
  compLabel.className = 'comp-label';
  compLabel.textContent = 'O agrega URLs manualmente (opcional, hasta 3, una por línea)';
  compSection.appendChild(compLabel);
  const compTextarea = document.createElement('textarea');
  compTextarea.id = 'comp-input';
  compTextarea.name = 'competitors';
  compTextarea.rows = 2;
  compTextarea.spellcheck = false;
  compTextarea.autocomplete = 'off';
  compTextarea.placeholder = 'https://competidor1.com\nhttps://competidor2.com';
  compSection.appendChild(compTextarea);

  detailedBox.appendChild(compSection);
  form.appendChild(detailedBox);

  // Toggle handler — abre/cierra la caja del detallado y resetea la passphrase
  ppToggle.addEventListener('change', () => {
    detailedBox.hidden = !ppToggle.checked;
    if (!ppToggle.checked) {
      ppInput.value = '';
      // No limpiamos sugerencias para que el usuario no pierda trabajo si re-toggla.
    }
  });

  // Detectar competidores con IA
  detectBtn.addEventListener('click', async () => {
    if (!lastUrl) {
      renderDetectError(suggestionsList, 'Vuelve a escanear tu sitio antes de detectar competidores.');
      return;
    }
    detectBtn.disabled = true;
    const originalLabel = detectBtn.textContent;
    detectBtn.textContent = 'Detectando…';
    try {
      const res = await fetch('/api/suggest-competitors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: lastUrl }),
      });
      const data = (await res.json().catch(() => null)) as
        | { competitors?: Array<{ domain: string; reason: string }>; error?: string }
        | null;
      if (!res.ok || !data || !Array.isArray(data.competitors)) {
        renderDetectError(
          suggestionsList,
          (data && 'error' in data && data.error) ||
            'No pudimos sugerir competidores. Puedes pegarlos manualmente abajo.'
        );
        return;
      }
      renderSuggestions(suggestionsList, data.competitors);
    } catch {
      renderDetectError(suggestionsList, 'No pudimos conectar. Pega las URLs manualmente abajo.');
    } finally {
      detectBtn.disabled = false;
      detectBtn.textContent = originalLabel;
    }
  });

  // --- Submit ---
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Enviarme el informe';
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

    // 1) Passphrase solo si el toggle está activo y tiene algo.
    const passRaw = (ppInput.value || '').trim();

    // 2) Competidores: union de chips marcados + URLs manuales (dedup por dominio,
    //    máximo 3). El backend (validate.ts) ya rechaza privados/inválidos.
    const picked = new Set<string>();
    suggestionsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
      if (cb.checked) picked.add(cb.value.trim().toLowerCase());
    });
    const manual = (compTextarea.value || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const raw of manual) {
      let d = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (d) picked.add(d);
      if (picked.size >= 3) break;
    }
    const competitors = Array.from(picked).slice(0, 3);

    // Guardamos lo que se mandó al backend para construir luego el link al PDF.
    lastPassphrase = passRaw;
    lastCompetitors = competitors;

    const body: {
      url: string;
      email: string;
      passphrase?: string;
      competitors?: string[];
    } = { url: lastUrl, email };
    if (passRaw) body.passphrase = passRaw;
    if (competitors.length) body.competitors = competitors;
    await runScan(output, body, { unlock: true });
  });

  return box;
}

// Botón "Descargar reporte PDF" — abre /report en nueva ventana con los params
// del último escaneo detailed. El passphrase viaja en query string porque es
// la versión de pruebas; cuando se enchufe Stripe se reemplaza por un token de
// sesión y esto deja de ser necesario.
function renderPdfButton(): HTMLElement {
  const box = el('div', 'pdf-cta');
  const a = document.createElement('a');
  a.className = 'btn btn-primary btn-block';
  a.textContent = 'Descargar reporte PDF';
  a.target = '_blank';
  a.rel = 'noopener';
  const sp = new URLSearchParams();
  if (lastUrl) sp.set('url', lastUrl);
  if (lastEmail) sp.set('email', lastEmail);
  if (lastPassphrase) sp.set('passphrase', lastPassphrase);
  if (lastCompetitors.length) sp.set('competitors', lastCompetitors.join(','));
  a.href = '/report?' + sp.toString();
  box.appendChild(a);
  const hint = el('p', 'pdf-hint');
  hint.textContent =
    'Abre el reporte en una pestaña nueva. Usa “Imprimir → Guardar como PDF” para bajarlo.';
  box.appendChild(hint);
  return box;
}

// Pinta los chips de sugerencias (checkbox + dominio + razón corta).
function renderSuggestions(
  container: HTMLElement,
  items: Array<{ domain: string; reason: string }>
): void {
  container.innerHTML = '';
  if (!items.length) {
    const p = el('p', 'comp-empty');
    p.textContent = 'La IA no encontró competidores claros. Pega URLs abajo o sigue sin comparar.';
    container.appendChild(p);
    container.hidden = false;
    return;
  }
  const intro = el('p', 'comp-suggestions-intro');
  intro.textContent = 'Sugerencias de la IA — desmarca las que no quieras comparar:';
  container.appendChild(intro);
  for (const it of items) {
    const chip = el('label', 'comp-chip');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.domain;
    cb.checked = true;
    chip.appendChild(cb);
    const text = el('span', 'comp-chip-text');
    text.textContent = it.domain;
    chip.appendChild(text);
    if (it.reason) {
      const why = el('span', 'comp-chip-why');
      why.textContent = it.reason;
      chip.appendChild(why);
    }
    container.appendChild(chip);
  }
  container.hidden = false;
}

function renderDetectError(container: HTMLElement, msg: string): void {
  container.innerHTML = '';
  const p = el('p', 'comp-empty');
  p.textContent = msg;
  container.appendChild(p);
  container.hidden = false;
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

// --- Informe detallado (nivel 'detailed') — solo llega si el backend lo trae ---
// Cada subsección degrada por separado: si la comparación falla, igual pintamos
// las preguntas-cliente (si llegaron) y un fallback honesto si nada llegó.
function renderDetailed(rep: DetailedReport): HTMLElement {
  const box = el('div', 'detailed');

  const hasCompetitors =
    rep.competitors !== null ||
    rep.competitorsSummary !== null ||
    rep.clientComparison !== null;
  const hasQuestions = rep.clientQuestions !== null && rep.clientQuestions.length > 0;

  // Si no llegó NADA del backend, mensaje honesto en vez de secciones vacías.
  if (!hasCompetitors && !hasQuestions) {
    const empty = el('p', 'detailed-empty');
    empty.textContent =
      'No pudimos generar el informe detallado en este momento. Inténtalo de nuevo en unos minutos.';
    box.appendChild(empty);
    return box;
  }

  // Cabecera: deja claro que esto es ANALISIS EXTRA (más allá del escaneo gratis).
  const intro = el('p', 'detailed-intro');
  intro.textContent =
    'Estas secciones vienen del informe detallado: análisis extra que el escaneo gratis no hace (comparación con competidores y preguntas que un cliente le haría a una IA).';
  box.appendChild(intro);

  if (hasCompetitors) {
    box.appendChild(renderComparison(rep));
  }
  if (hasQuestions && rep.clientQuestions) {
    box.appendChild(renderQuestions(rep.clientQuestions));
  }

  return box;
}

function scoreCell(value: number | null | undefined): { text: string; color: string } {
  if (value == null) return { text: '—', color: 'var(--muted)' };
  if (value >= 70) return { text: String(value), color: 'var(--good)' };
  if (value >= 45) return { text: String(value), color: 'var(--mid)' };
  return { text: String(value), color: 'var(--bad)' };
}

function renderComparison(rep: DetailedReport): HTMLElement {
  const section = el('section', 'detailed-section');

  const h = el('h3', 'section-title');
  h.textContent = 'Tu sitio vs. la competencia';
  section.appendChild(h);

  const cmpNote = el('p', 'detailed-note');
  cmpNote.textContent =
    'Cada sitio se evalúa con el mismo método, así que la comparación es justa.';
  section.appendChild(cmpNote);

  const table = el('table', 'cmp-table');

  // Header
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(thCell('Sitio'));
  headRow.appendChild(thCell('Puntaje'));
  headRow.appendChild(thCell('Técnico'));
  headRow.appendChild(thCell('Negocio'));
  headRow.appendChild(thCell('Citabilidad'));
  headRow.appendChild(thCell('Autoridad'));
  headRow.appendChild(thCell('Geográfica'));
  thead.appendChild(headRow);
  table.appendChild(thead);

  // Fila del cliente (la pintamos destacada)
  if (rep.clientComparison) {
    const subs = rep.clientComparison.subScores;
    const row = document.createElement('tr');
    row.className = 'cmp-row cmp-row-client';
    row.appendChild(tdCell('Tu sitio', true));
    const final = scoreCell(rep.clientComparison.finalScore);
    row.appendChild(tdCell(`${final.text} / 100`, false, final.color, true));
    row.appendChild(tdCell(subs ? String(subs.tecnico) : '—'));
    row.appendChild(tdCell(subs ? String(subs.claridadNegocio) : '—'));
    row.appendChild(tdCell(subs ? String(subs.citabilidad) : '—'));
    row.appendChild(tdCell(subs ? String(subs.autoridad) : '—'));
    row.appendChild(tdCell(subs ? String(subs.claridadGeografica) : '—'));
    table.appendChild(row);
  }

  // Filas de competidores
  if (rep.competitors) {
    for (const c of rep.competitors) {
      const row = document.createElement('tr');
      row.className = 'cmp-row';
      const domainCell = c.error ? `⚠ ${c.domain}` : c.domain;
      row.appendChild(tdCell(domainCell));
      const final = scoreCell(c.finalScore);
      row.appendChild(tdCell(`${final.text} / 100`, false, final.color, true));
      const sub = c.subScores;
      row.appendChild(tdCell(sub ? String(sub.tecnico) : '—'));
      row.appendChild(tdCell(sub ? String(sub.claridadNegocio) : '—'));
      row.appendChild(tdCell(sub ? String(sub.citabilidad) : '—'));
      row.appendChild(tdCell(sub ? String(sub.autoridad) : '—'));
      row.appendChild(tdCell(sub ? String(sub.claridadGeografica) : '—'));
      table.appendChild(row);
    }
  }

  section.appendChild(table);

  if (rep.competitorsSummary) {
    const prose = el('p', 'cmp-summary');
    prose.textContent = rep.competitorsSummary;
    section.appendChild(prose);
  }

  return section;
}

function renderQuestions(questions: ClientQuestion[]): HTMLElement {
  const section = el('section', 'detailed-section');
  const h = el('h3', 'section-title');
  h.textContent = 'Preguntas que un cliente le haría a una IA';
  section.appendChild(h);

  const intro = el('p', 'detailed-note');
  intro.textContent =
    'Estas son preguntas reales que alguien en tu rubro le haría a una IA. Te decimos si tu sitio tiene contenido para que la IA te cite como respuesta.';
  section.appendChild(intro);

  const list = el('ul', 'q-list');
  for (const q of questions) {
    const item = el('li', 'q-item');
    const tag = el('span', q.cubierta ? 'q-tag q-yes' : 'q-tag q-no');
    tag.textContent = q.cubierta ? 'Cubierta' : 'Falta';
    item.appendChild(tag);
    const body = el('div', 'q-body');
    const p = el('p', 'q-q');
    p.textContent = q.pregunta;
    const nota = el('p', 'q-nota');
    nota.textContent = q.nota;
    body.appendChild(p);
    body.appendChild(nota);
    item.appendChild(body);
    list.appendChild(item);
  }
  section.appendChild(list);

  return section;
}

function thCell(text: string): HTMLElement {
  const node = el('th', 'cmp-th');
  node.textContent = text;
  return node;
}
function tdCell(
  text: string,
  isLabel = false,
  color = 'var(--ink)',
  bold = false
): HTMLElement {
  const node = el('td', isLabel ? 'cmp-td cmp-label' : 'cmp-td');
  node.textContent = text;
  if (color !== 'var(--ink)') node.style.color = color;
  if (bold) node.style.fontWeight = '700';
  return node;
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
