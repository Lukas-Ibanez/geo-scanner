// Envío del informe GEO por correo vía Resend (API REST, sin SDK → funciona en Workers).
// El envío es "best-effort": si falla no debe tumbar el escaneo (ya se guardó el lead).
// El email es un informe MÁS DETALLADO que la vista en pantalla: añade interpretación
// del puntaje, desglose explicado por dimensión y un diagnóstico técnico punto por punto.
import type {
  ScanResult,
  SubScores,
  TechnicalCheck,
  DetailedReport,
  ClientQuestion,
  ActionItem,
  CompetitorInsight,
} from './types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// CTA al servicio pagado (puente lead magnet → venta). Configurable por env.
const DEFAULT_CTA_URL = 'https://lukasibanez.dev/#servicios';
// Remitente por defecto. Debe estar en un dominio verificado en Resend.
const DEFAULT_FROM = 'GEO Scanner <informe@geo.lukasibanez.dev>';
// Origen público del sitio (para armar links absolutos al reporte PDF en el
// correo). Configurable por env; default al dominio de producción.
const DEFAULT_PUBLIC_URL = 'https://geo.lukasibanez.dev';

// Construye la URL absoluta al reporte PDF (/report?...). Vacía si no hay
// passphrase (porque /report exige level==='detailed', que solo se alcanza
// con passphrase válida).
function buildReportUrl(
  publicUrl: string,
  result: ScanResult,
  passphrase: string,
  competitors: string[]
): string {
  if (!passphrase) return '';
  const sp = new URLSearchParams();
  sp.set('url', result.url);
  if (result.url) {
    // sacamos el email desde el result si lo tuviéramos; acá no lo tenemos,
    // así que se omite sin drama — /report solo requiere url + passphrase.
  }
  sp.set('passphrase', passphrase);
  if (competitors.length) sp.set('competitors', competitors.join(','));
  // Quita slash final del origin si lo tiene.
  const base = publicUrl.replace(/\/$/, '');
  return `${base}/report?${sp.toString()}`;
}

// Qué mide cada dimensión y por qué importa (lenguaje de negocio). Fuente única.
const DIMENSIONS: Array<{ key: keyof SubScores; label: string; about: string }> = [
  {
    key: 'tecnico',
    label: 'Preparación técnica',
    about:
      'Si la estructura, los metadatos y los permisos de tu sitio le permiten a una IA leerte y entenderte sin tropiezos.',
  },
  {
    key: 'claridadNegocio',
    label: 'Claridad del negocio',
    about: 'Si una IA entiende sin esfuerzo qué producto o servicio ofreces y para quién.',
  },
  {
    key: 'citabilidad',
    label: 'Facilidad para ser citado',
    about: 'Qué tan fácil es para una IA tomar tu contenido y citarlo como respuesta a una pregunta.',
  },
  {
    key: 'autoridad',
    label: 'Señales de autoridad',
    about: 'Las señales de experiencia, confianza y reputación que hacen que una IA prefiera recomendarte.',
  },
  {
    key: 'claridadGeografica',
    label: 'Claridad geográfica',
    about: 'Si queda claro en qué ciudad o zona operas, para que la IA te recomiende a quien busca cerca.',
  },
];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bandColor(score: number): string {
  if (score >= 70) return '#19a974';
  if (score >= 45) return '#f5a524';
  return '#ef4444';
}

function bandLabel(score: number): string {
  if (score >= 70) return 'Bien';
  if (score >= 45) return 'Aceptable';
  return 'A mejorar';
}

function scoreInterpretation(result: ScanResult): string {
  if (result.blocksAiBots) {
    return 'Tu sitio está bloqueando a los robots de IA. Mientras eso siga así, herramientas como ChatGPT, Perplexity o Google AI no pueden leer tu contenido para recomendarte, por más bueno que sea. Es lo primero a resolver.';
  }
  const s = result.finalScore;
  if (s >= 80)
    return 'Tu sitio está bien preparado para aparecer en respuestas de IA. Lo que sigue son ajustes finos para consolidar tu ventaja.';
  if (s >= 60)
    return 'Tienes una base decente, pero hay vacíos concretos que reducen tus chances de aparecer cuando alguien le pregunta a una IA por lo que ofreces. Cerrarlos tiene impacto directo.';
  if (s >= 40)
    return 'Hoy las IA tienen dificultad para entender qué ofreces y dónde operas, así que estás perdiendo oportunidades de aparecer en sus respuestas. Hay mucho margen de mejora con cambios acotados.';
  return 'Hoy es muy poco probable que una IA recomiende tu sitio: no logra entender bien qué haces ni para quién. La buena noticia es que casi todo lo que falta es accionable.';
}

// Color del puntaje para el informe detallado (gris si no hay dato).
function detailedScoreColor(score: number | null | undefined): string {
  if (score == null) return '#64708a';
  if (score >= 70) return '#19a974';
  if (score >= 45) return '#f5a524';
  return '#ef4444';
}

// ¿El informe detallado tiene ALGO útil? Si todas las secciones degradaron a
// null, devolvemos un fallback honesto en vez de un email con bloques vacíos.
function detailedHasContent(rep: DetailedReport): boolean {
  return !!(
    (rep.competitors && rep.competitors.length > 0) ||
    rep.clientComparison ||
    rep.competitorsSummary ||
    (rep.clientQuestions && rep.clientQuestions.length > 0) ||
    (rep.actionPlan && rep.actionPlan.length > 0) ||
    rep.aiPerception ||
    rep.executiveSummary
  );
}

// --- Bloques HTML ---

function dimensionBlockHtml(label: string, about: string, val: number): string {
  const color = bandColor(val);
  return `
    <tr><td style="padding:0 0 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:15px;font-weight:700;color:#15203a;">${esc(label)}</td>
          <td align="right" style="font-size:13px;font-weight:700;color:${color};">${val}/100 · ${bandLabel(val)}</td>
        </tr>
        <tr><td colspan="2" style="padding:8px 0 6px;">
          <div style="height:8px;border-radius:999px;background:#eef3ff;">
            <div style="height:8px;width:${Math.max(2, Math.min(100, val))}%;border-radius:999px;background:${color};"></div>
          </div>
        </td></tr>
        <tr><td colspan="2" style="font-size:13px;line-height:1.5;color:#64708a;">${esc(about)}</td></tr>
      </table>
    </td></tr>`;
}

// --- Bloques del informe detallado (nivel 'detailed') ---
// Estilo consistente con el resto del correo. Si detailedReport es null, no se
// llama a esta función (la llamada vive en renderHtml/renderText).

function detailedCompareHtml(rep: DetailedReport): string {
  const items: Array<{ label: string; isClient: boolean; finalScore: number | null; subScores: SubScores | null; aiAvailable?: boolean; error?: string }> = [];

  if (rep.clientComparison) {
    items.push({
      label: 'Tu sitio',
      isClient: true,
      finalScore: rep.clientComparison.finalScore,
      subScores: rep.clientComparison.subScores,
      aiAvailable: rep.clientComparison.aiAvailable,
    });
  }
  if (rep.competitors) {
    for (const c of rep.competitors) {
      items.push({
        label: c.error ? `${c.domain} (no se pudo evaluar)` : c.domain,
        isClient: false,
        finalScore: c.finalScore,
        subScores: c.subScores,
        aiAvailable: c.aiAvailable,
        error: c.error,
      });
    }
  }
  if (items.length === 0) return '';

  const rows = items
    .map((e) => {
      const col = detailedScoreColor(e.finalScore);
      const subs = e.subScores;
      const borderColor = e.isClient ? '#dde7ff' : '#e7ecf6';
      const bg = e.isClient ? 'background:#f4f7ff;' : '';
      const labelColor = e.isClient ? '#2f4fc7' : '#15203a';
      // "—" en las dimensiones de contenido si la IA no pudo evaluar ese sitio
      // (un 0 de relleno parece un puntaje real y confunde).
      const dim = (v: number) => (e.aiAvailable === false ? '—' : String(v));
      const subLine = subs
        ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.6;color:#64708a;">Técnico <b style="color:#15203a;">${subs.tecnico}</b> · Negocio <b style="color:#15203a;">${dim(subs.claridadNegocio)}</b> · Citabilidad <b style="color:#15203a;">${dim(subs.citabilidad)}</b> · Autoridad <b style="color:#15203a;">${dim(subs.autoridad)}</b> · Geográfica <b style="color:#15203a;">${dim(subs.claridadGeografica)}</b></p>`
        : e.error
        ? `<p style="margin:6px 0 0;font-size:12px;color:#9a2b2b;">No pudimos leer este sitio (${esc(e.error)}). Inténtalo más tarde.</p>`
        : '';
      const scoreText = e.finalScore == null ? '—' : String(e.finalScore);
      const scoreUnit = e.finalScore == null ? '' : '<span style="font-size:13px;color:#64708a;font-weight:600;"> / 100</span>';
      return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;border-radius:12px;border:1px solid ${borderColor};${bg}">
          <tr><td style="padding:12px 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:15px;font-weight:700;color:${labelColor};">${esc(e.label)}</td>
                <td align="right" style="font-size:18px;font-weight:800;color:${col};">${scoreText}${scoreUnit}</td>
              </tr>
            </table>
            ${subLine}
          </td></tr>
        </table>`;
    })
    .join('');

  return `
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">Tu sitio vs. la competencia</p>
    <p style="margin:0 0 14px;font-size:12px;line-height:1.55;color:#64708a;">Cada sitio se evaluó con el mismo método, así que la comparación es justa.</p>
    ${rows}`;
}

function detailedQuestionsHtml(questions: ClientQuestion[]): string {
  if (!questions.length) return '';
  const items = questions
    .map((q) => {
      const tagColor = q.cubierta ? '#0f7a55' : '#c0392b';
      const tagText = q.cubierta ? '✓ CUBIERTA' : '✗ FALTA';
      return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;border-radius:12px;border:1px solid #e7ecf6;">
          <tr><td style="padding:12px 16px;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.04em;color:${tagColor};">${tagText}</p>
            <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#15203a;line-height:1.4;">${esc(q.pregunta)}</p>
            <p style="margin:0;font-size:13px;line-height:1.5;color:#64708a;">${esc(q.nota)}</p>
          </td></tr>
        </table>`;
    })
    .join('');
  return `
    <p style="margin:18px 0 10px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">Preguntas que un cliente le haría a una IA</p>
    <p style="margin:0 0 14px;font-size:12px;line-height:1.55;color:#64708a;">Preguntas reales del rubro. Te decimos si tu sitio tiene contenido para que una IA te cite como respuesta.</p>
    ${items}`;
}

function detailedSummaryHtml(summary: string): string {
  return `
    <p style="margin:18px 0 10px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">Síntesis</p>
    <p style="margin:0 0 4px;font-size:14px;line-height:1.55;color:#15203a;background:#eef3ff;padding:14px 16px;border-radius:14px;">${esc(summary)}</p>`;
}

// "Cómo te describiría una IA hoy": espejo de la sección del PDF, en compacto.
function detailedPerceptionHtml(perception: string): string {
  return `
    <p style="margin:18px 0 10px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">Cómo te describiría una IA hoy</p>
    <p style="margin:0 0 4px;font-size:14px;line-height:1.55;color:#15203a;background:#f7f9fd;border:1px solid #e7ecf6;padding:14px 16px;border-radius:14px;">${esc(perception)}</p>`;
}

const LEVEL_LABELS: Record<string, string> = { alto: 'Alto', medio: 'Medio', bajo: 'Bajo' };

// Plan de acción priorizado (núcleo del informe premium): qué hacer, en orden.
function detailedActionPlanHtml(plan: ActionItem[]): string {
  if (!plan.length) return '';
  const items = plan
    .map((a, i) => {
      const impactColor = a.impacto === 'alto' ? '#0f7a55' : a.impacto === 'medio' ? '#b26a00' : '#64708a';
      return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;border-radius:12px;border:1px solid #e7ecf6;">
          <tr><td style="padding:12px 16px;">
            <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#15203a;line-height:1.4;">${i + 1}. ${esc(a.accion)}</p>
            ${a.porQue ? `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#64708a;">${esc(a.porQue)}</p>` : ''}
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.03em;">
              <span style="color:${impactColor};">IMPACTO ${esc((LEVEL_LABELS[a.impacto] || a.impacto).toUpperCase())}</span>
              <span style="color:#9aa7bd;"> · ESFUERZO ${esc((LEVEL_LABELS[a.esfuerzo] || a.esfuerzo).toUpperCase())} · ${esc(a.plazo.toUpperCase())}</span>
            </p>
          </td></tr>
        </table>`;
    })
    .join('');
  return `
    <p style="margin:18px 0 10px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">Plan de acción priorizado</p>
    <p style="margin:0 0 14px;font-size:12px;line-height:1.55;color:#64708a;">Qué hacer y en qué orden. La implementación de cada punto la puedes delegar — este plan te dice qué priorizar.</p>
    ${items}`;
}

// En qué te gana cada competidor (acompaña la tabla comparativa).
function detailedInsightsHtml(insights: CompetitorInsight[]): string {
  if (!insights.length) return '';
  const items = insights
    .map(
      (i) => `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;border-radius:12px;border:1px solid #e7ecf6;">
          <tr><td style="padding:12px 16px;">
            <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#2f4fc7;">${esc(i.domain)}</p>
            <p style="margin:0;font-size:13px;line-height:1.5;color:#15203a;">${esc(i.queHacenMejor)}</p>
          </td></tr>
        </table>`
    )
    .join('');
  return `
    <p style="margin:18px 0 10px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">Qué hace cada competidor que a ti te falta</p>
    ${items}`;
}

function detailedEmailHtml(rep: DetailedReport, reportUrl: string): string {
  if (!detailedHasContent(rep)) {
    return `
      <tr><td style="padding:28px 28px 4px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#3b63ec;">INFORME DETALLADO</p>
        <p style="margin:6px 0 0;font-size:14px;line-height:1.55;color:#64708a;">
          No pudimos generar las secciones detalladas (comparativa con competidores y preguntas-cliente) en este momento. Inténtalo de nuevo en unos minutos.
        </p>
        ${reportUrl ? detailedPdfCtaHtml(reportUrl) : ''}
      </td></tr>`;
  }

  const perceptionHtml = rep.aiPerception ? detailedPerceptionHtml(rep.aiPerception) : '';
  const planHtml = rep.actionPlan ? detailedActionPlanHtml(rep.actionPlan) : '';
  const compareHtml = detailedCompareHtml(rep);
  const insightsHtml = rep.competitorInsights ? detailedInsightsHtml(rep.competitorInsights) : '';
  const questionsHtml = rep.clientQuestions ? detailedQuestionsHtml(rep.clientQuestions) : '';
  const summaryHtml = rep.competitorsSummary ? detailedSummaryHtml(rep.competitorsSummary) : '';

  return `
    <tr><td style="padding:28px 28px 4px;">
      <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#3b63ec;">INFORME DETALLADO</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#64708a;">
        Análisis que el escaneo gratis no hace: cómo te ven las IA, tu plan de acción priorizado, tu sitio comparado con la competencia y las preguntas reales que un cliente le haría a una IA.
      </p>
      ${perceptionHtml}
      ${planHtml}
      ${compareHtml}
      ${summaryHtml}
      ${insightsHtml}
      ${questionsHtml}
      ${reportUrl ? detailedPdfCtaHtml(reportUrl) : ''}
    </td></tr>`;
}

// CTA al reporte PDF completo (botón "Ver / Imprimir como PDF"). Solo se
// muestra si tenemos la URL armada (pasphrase válida → /report accesible).
function detailedPdfCtaHtml(reportUrl: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-radius:14px;border:1px solid #dde7ff;background:#f4f7ff;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#2f4fc7;">REPORTE COMPLETO EN PDF</p>
        <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#15203a;">
          Abre la versión completa, lista para imprimir o guardar como PDF. Incluye el plan de acción priorizado y el desglose técnico.
        </p>
        <a href="${esc(reportUrl)}" style="display:inline-block;background:#2f4fc7;color:#ffffff;font-weight:700;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:10px;">Ver / Imprimir como PDF</a>
      </td></tr>
    </table>`;
}

// Versión texto plano (sigue a la sección "Plan de mejoras").
function detailedTextLines(rep: DetailedReport): string[] {
  if (!detailedHasContent(rep)) {
    return [
      '',
      'INFORME DETALLADO',
      'No pudimos generar las secciones detalladas (comparativa con competidores y preguntas-cliente) en este momento. Inténtalo de nuevo en unos minutos.',
    ];
  }
  const out: string[] = ['', 'INFORME DETALLADO', 'Análisis extra que el escaneo gratis no hace.'];

  if (rep.aiPerception) {
    out.push('', 'CÓMO TE DESCRIBIRÍA UNA IA HOY');
    out.push(rep.aiPerception);
  }

  if (rep.actionPlan && rep.actionPlan.length) {
    out.push('', 'PLAN DE ACCIÓN PRIORIZADO');
    rep.actionPlan.forEach((a, i) => {
      out.push(`${i + 1}. ${a.accion}`);
      if (a.porQue) out.push(`   ${a.porQue}`);
      out.push(`   Impacto: ${a.impacto} · Esfuerzo: ${a.esfuerzo} · Plazo: ${a.plazo}`);
    });
  }

  if (rep.competitors || rep.clientComparison) {
    out.push('', 'TU SITIO VS. LA COMPETENCIA');
    const subLine = (s: SubScores, aiAvailable?: boolean): string => {
      const dim = (v: number) => (aiAvailable === false ? '—' : String(v));
      return `  Técnico ${s.tecnico} · Negocio ${dim(s.claridadNegocio)} · Citabilidad ${dim(s.citabilidad)} · Autoridad ${dim(s.autoridad)} · Geográfica ${dim(s.claridadGeografica)}`;
    };
    if (rep.clientComparison) {
      const c = rep.clientComparison;
      out.push(`- Tu sitio: ${c.finalScore ?? '—'}/100`);
      if (c.subScores) out.push(subLine(c.subScores, c.aiAvailable));
    }
    if (rep.competitors) {
      for (const comp of rep.competitors) {
        const errNote = comp.error ? ` (no se pudo evaluar: ${comp.error})` : '';
        out.push(`- ${comp.domain}${errNote}: ${comp.finalScore ?? '—'}/100`);
        if (comp.subScores) out.push(subLine(comp.subScores, comp.aiAvailable));
      }
    }
  }

  if (rep.clientQuestions && rep.clientQuestions.length) {
    out.push('', 'PREGUNTAS QUE UN CLIENTE LE HARÍA A UNA IA');
    rep.clientQuestions.forEach((q) => {
      out.push(`[${q.cubierta ? '✓' : '✗'}] ${q.pregunta}`);
      out.push(`  ${q.nota}`);
    });
  }

  if (rep.competitorsSummary) {
    out.push('', 'SÍNTESIS');
    out.push(rep.competitorsSummary);
  }

  if (rep.competitorInsights && rep.competitorInsights.length) {
    out.push('', 'QUÉ HACE CADA COMPETIDOR QUE A TI TE FALTA');
    rep.competitorInsights.forEach((i) => {
      out.push(`- ${i.domain}: ${i.queHacenMejor}`);
    });
  }
  return out;
}

function techRowHtml(c: TechnicalCheck): string {
  const ok = c.passed;
  const icon = ok ? '✓' : '✗';
  const iconBg = ok ? '#e9f8f1' : '#fdecec';
  const iconColor = ok ? '#0f7a55' : '#c0392b';
  return `
    <tr>
      <td valign="top" style="padding:0 12px 12px 0;">
        <div style="width:24px;height:24px;border-radius:7px;background:${iconBg};color:${iconColor};font-weight:700;font-size:14px;line-height:24px;text-align:center;">${icon}</div>
      </td>
      <td valign="top" style="padding:0 0 12px;font-size:14px;line-height:1.5;color:#15203a;">
        ${esc(c.label)}
        <span style="display:inline-block;margin-left:6px;font-size:11px;font-weight:700;color:#9aa7bd;">${c.points}/${c.maxPoints} pts</span>
      </td>
    </tr>`;
}

export function renderHtml(result: ScanResult, ctaUrl: string, reportUrl: string): string {
  const color = bandColor(result.finalScore);

  const dims = DIMENSIONS.filter((d) => d.key === 'tecnico' || result.aiAnalysisAvailable)
    .map((d) => dimensionBlockHtml(d.label, d.about, result.subScores[d.key]))
    .join('');

  const checks = result.technicalChecks || [];
  const failed = checks.filter((c) => !c.passed).sort((a, b) => b.maxPoints - a.maxPoints);
  const passed = checks.filter((c) => c.passed).sort((a, b) => b.maxPoints - a.maxPoints);

  const techSection = checks.length
    ? `
      <tr><td style="padding:28px 28px 4px;">
        <h2 style="margin:0 0 4px;font-size:18px;">Diagnóstico técnico, punto por punto</h2>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#64708a;">Esto es lo que revisamos en tu sitio, ordenado por impacto.</p>
        ${
          failed.length
            ? `<p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#c0392b;">Lo que falta resolver</p>
               <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${failed.map(techRowHtml).join('')}</table>`
            : ''
        }
        ${
          passed.length
            ? `<p style="margin:${failed.length ? '14px' : '0'} 0 10px;font-size:13px;font-weight:700;color:#0f7a55;">Lo que ya tienes bien</p>
               <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${passed.map(techRowHtml).join('')}</table>`
            : ''
        }
      </td></tr>`
    : '';

  const recs = (result.recommendations || [])
    .map(
      (text, i) => `
        <tr>
          <td valign="top" style="padding:0 12px 14px 0;">
            <div style="width:26px;height:26px;border-radius:8px;background:#3b63ec;color:#fff;font-weight:700;font-size:13px;line-height:26px;text-align:center;">${i + 1}</div>
          </td>
          <td valign="top" style="padding:0 0 14px 0;font-size:15px;line-height:1.55;color:#15203a;">${esc(text)}</td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f9fbff;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15203a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fbff;padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e7ecf6;border-radius:18px;overflow:hidden;">
        <tr><td style="padding:28px 28px 8px;">
          <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:.04em;color:#3b63ec;">TU INFORME GEO</p>
          <h1 style="margin:6px 0 0;font-size:22px;line-height:1.25;">Resultado para ${esc(result.domain)}</h1>
        </td></tr>

        <tr><td align="center" style="padding:18px 28px 4px;">
          <div style="font-size:54px;font-weight:800;line-height:1;color:${color};">${result.finalScore}<span style="font-size:20px;color:#64708a;font-weight:600;">/100</span></div>
          <p style="margin:10px 0 0;font-size:15px;line-height:1.5;color:#15203a;">${esc(result.verdict)}</p>
        </td></tr>

        <tr><td style="padding:20px 28px 4px;">
          <div style="background:#eef3ff;border-radius:14px;padding:16px 18px;">
            <p style="margin:0;font-size:13px;font-weight:700;color:#2f4fc7;">Qué significa tu puntaje</p>
            <p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#15203a;">${esc(scoreInterpretation(result))}</p>
          </div>
        </td></tr>

        <tr><td style="padding:28px 28px 4px;">
          <h2 style="margin:0 0 16px;font-size:18px;">Tu puntaje, dimensión por dimensión</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${dims}</table>
        </td></tr>

        ${techSection}

        ${
          recs
            ? `<tr><td style="padding:28px 28px 4px;">
                 <h2 style="margin:0 0 4px;font-size:18px;">Plan de mejoras priorizado</h2>
                 <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#64708a;">Empieza por arriba: están ordenadas por el impacto que tienen en tu visibilidad ante las IA.</p>
                 <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${recs}</table>
               </td></tr>`
            : ''
        }

        ${result.detailedReport ? detailedEmailHtml(result.detailedReport, reportUrl) : ''}

        <tr><td style="padding:24px 28px 30px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#3b63ec;border-radius:14px;">
            <tr><td style="padding:24px;text-align:center;">
              <p style="margin:0 0 6px;font-size:17px;font-weight:700;color:#ffffff;">¿Quieres que lo implemente por ti?</p>
              <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#dde7ff;">Implemento estas mejoras para que las IA te encuentren, te entiendan y te recomienden. Tú te concentras en tu negocio.</p>
              <a href="${esc(ctaUrl)}" style="display:inline-block;background:#ffffff;color:#2f4fc7;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:12px;">Quiero que lo hagan por mí</a>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <p style="max-width:600px;margin:16px auto 0;font-size:12px;color:#64708a;text-align:center;line-height:1.5;">
        Recibes este correo porque pediste tu informe en GEO Scanner.<br>
        Una herramienta de <a href="https://lukasibanez.dev" style="color:#3b63ec;">lukasibanez.dev</a>.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function renderText(result: ScanResult, ctaUrl: string, reportUrl: string): string {
  const lines = [
    `TU INFORME GEO — ${result.domain}`,
    `Puntaje: ${result.finalScore}/100`,
    '',
    result.verdict,
    '',
    'QUÉ SIGNIFICA TU PUNTAJE',
    scoreInterpretation(result),
    '',
    'TU PUNTAJE, DIMENSIÓN POR DIMENSIÓN',
  ];
  for (const d of DIMENSIONS) {
    if (d.key !== 'tecnico' && !result.aiAnalysisAvailable) continue;
    const v = result.subScores[d.key];
    lines.push(`- ${d.label}: ${v}/100 (${bandLabel(v)}) — ${d.about}`);
  }

  const checks = result.technicalChecks || [];
  if (checks.length) {
    const failed = checks.filter((c) => !c.passed).sort((a, b) => b.maxPoints - a.maxPoints);
    const passed = checks.filter((c) => c.passed).sort((a, b) => b.maxPoints - a.maxPoints);
    lines.push('', 'DIAGNÓSTICO TÉCNICO, PUNTO POR PUNTO');
    if (failed.length) {
      lines.push('Lo que falta resolver:');
      failed.forEach((c) => lines.push(`  [✗] ${c.label} (${c.points}/${c.maxPoints} pts)`));
    }
    if (passed.length) {
      lines.push('Lo que ya tienes bien:');
      passed.forEach((c) => lines.push(`  [✓] ${c.label} (${c.points}/${c.maxPoints} pts)`));
    }
  }

  if (result.recommendations && result.recommendations.length) {
    lines.push('', 'PLAN DE MEJORAS PRIORIZADO (ordenado por impacto)');
    result.recommendations.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }

  if (result.detailedReport) {
    lines.push(...detailedTextLines(result.detailedReport));
  }

  if (reportUrl) {
    lines.push('', 'REPORTE COMPLETO EN PDF', reportUrl);
  }

  lines.push(
    '',
    '¿Quieres que lo implemente por ti? Hablemos:',
    ctaUrl,
    '',
    'Una herramienta de https://lukasibanez.dev'
  );
  return lines.join('\n');
}

/**
 * Envía el informe completo al correo del lead. Best-effort: devuelve true/false
 * y nunca lanza (los errores se registran). No-op si falta RESEND_API_KEY.
 *
 * Si `passphrase` y `competitors` vienen (usuario desbloqueó el detallado),
 * incluye en el correo un link al reporte PDF completo en /report.
 */
export async function sendReportEmail(
  env: Env,
  to: string,
  result: ScanResult,
  opts: { passphrase?: string; competitors?: string[] } = {}
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('sendReportEmail: RESEND_API_KEY no configurado, se omite el envío.');
    return false;
  }
  const from = env.RESEND_FROM || DEFAULT_FROM;
  const ctaUrl = env.PORTFOLIO_CTA_URL || DEFAULT_CTA_URL;
  const publicUrl = env.PUBLIC_URL || DEFAULT_PUBLIC_URL;
  const reportUrl = buildReportUrl(
    publicUrl,
    result,
    opts.passphrase || '',
    opts.competitors || []
  );

  const body: Record<string, unknown> = {
    from,
    to: [to],
    subject: `Tu informe GEO: ${result.finalScore}/100 para ${result.domain}`,
    html: renderHtml(result, ctaUrl, reportUrl),
    text: renderText(result, ctaUrl, reportUrl),
  };
  if (env.RESEND_REPLY_TO) body.reply_to = env.RESEND_REPLY_TO;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('sendReportEmail failed', res.status, detail);
      return false;
    }
    return true;
  } catch (err) {
    console.error('sendReportEmail error:', err);
    return false;
  }
}
