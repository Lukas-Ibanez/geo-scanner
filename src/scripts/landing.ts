// Animaciones de la landing (solo se carga en index.astro).
// Tres piezas, todas progresivas y con fallback si algo falla:
//   1) Scroll-reveal: los bloques [data-reveal] aparecen al entrar en pantalla.
//   2) Gauge de ejemplo: el puntaje 0→72 + el anillo se dibujan al verse.
//   3) Demo de IA del hero: efecto máquina de escribir que cicla preguntas
//      reales y muestra cómo una IA "cita tu negocio" (etiquetado "Ejemplo").
//
// Respeta prefers-reduced-motion (el demo se muestra estático, sin tipeo).
// Si el script falla, revela todo el contenido para no dejar nada oculto.

declare global {
  interface Window {
    __landingReady?: boolean;
  }
}

const CIRC = 395.84; // circunferencia del anillo del gauge (2π·63)

function initReveal(): void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
  if (!('IntersectionObserver' in window)) {
    targets.forEach((t) => t.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );
  targets.forEach((t) => io.observe(t));
}

function initGauge(): void {
  const card = document.querySelector('.preview-card');
  const prog = document.querySelector<SVGCircleElement>('.pg-prog');
  const num = document.querySelector<HTMLElement>('.pg-num');
  if (!card || !prog || !num) return;

  const target = 72;
  const targetOffset = CIRC * (1 - target / 100);
  // Estado inicial: anillo vacío + número en 0.
  prog.style.strokeDashoffset = String(CIRC);
  num.textContent = '0';

  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    prog.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)';
    requestAnimationFrame(() => {
      prog.style.strokeDashoffset = String(targetOffset);
    });
    const start = performance.now();
    const dur = 1200;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      num.textContent = String(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  if (!('IntersectionObserver' in window)) {
    run();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          run();
          io.disconnect();
        }
      });
    },
    { threshold: 0.4 }
  );
  io.observe(card);
}

interface AiExample {
  q: string;
  a: string;
  cite: string;
}

const AI_EXAMPLES: AiExample[] = [
  {
    q: '¿Quién hace mantención de aire acondicionado en Santiago?',
    a: 'Una buena opción es Clima Norte: 12 años de experiencia y cobertura en toda la Región Metropolitana.',
    cite: 'climanorte.cl',
  },
  {
    q: '¿Dónde compro pan sin gluten en Concepción?',
    a: 'Panadería Semilla se especializa en sin gluten y está en Concepción centro.',
    cite: 'panaderiasemilla.cl',
  },
  {
    q: 'Recomiéndame un contador para pymes en Valparaíso.',
    a: 'Estudio Contable Mar trabaja con pymes y opera en Valparaíso y Viña.',
    cite: 'contablemar.cl',
  },
];

function initAiDemo(): void {
  const qEl = document.getElementById('ai-demo-q');
  const aEl = document.getElementById('ai-demo-a');
  const citeEl = document.getElementById('ai-demo-cite');
  if (!qEl || !aEl || !citeEl) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    const ex = AI_EXAMPLES[0];
    qEl.textContent = ex.q;
    aEl.textContent = ex.a;
    citeEl.textContent = ex.cite;
    citeEl.classList.add('is-in');
    return;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const idle = async () => {
    while (document.hidden) await sleep(400);
  };
  const type = async (el: HTMLElement, text: string, speed: number) => {
    el.classList.add('is-typing');
    el.textContent = '';
    for (let i = 0; i < text.length; i++) {
      el.textContent = text.slice(0, i + 1);
      await sleep(speed);
    }
    el.classList.remove('is-typing');
  };

  let i = 0;
  const loop = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await idle();
      const ex = AI_EXAMPLES[i % AI_EXAMPLES.length];
      citeEl.classList.remove('is-in');
      citeEl.textContent = '';
      aEl.textContent = '';
      await type(qEl, ex.q, 26);
      await sleep(450);
      await type(aEl, ex.a, 18);
      citeEl.textContent = ex.cite;
      citeEl.classList.add('is-in');
      await sleep(2800);
      i++;
    }
  };

  const demo = document.querySelector('.ai-demo');
  if (!demo || !('IntersectionObserver' in window)) {
    void loop();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          void loop();
          io.disconnect();
        }
      });
    },
    { threshold: 0.3 }
  );
  io.observe(demo);
}

try {
  window.__landingReady = true;
  initReveal();
  initGauge();
  initAiDemo();
} catch {
  // Si algo falla, no dejar contenido oculto.
  document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-in'));
}

export {};
