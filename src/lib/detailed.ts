// Informe detallado (nivel 'detailed', de pago): análisis que el escaneo gratis
// no hace. Genera TRES secciones independientes; si una falla devuelve null en
// esa sección SIN romper el resto del informe. Solo usa Claude (callClaudeTool)
// — sin web search ni otras IAs.
//
//   0) Resumen ejecutivo: 3 fortalezas + 3 brechas + veredicto (1 línea).
//   1) Comparación con competidores que ingresa el cliente.
//   2) Preguntas-cliente: qué le preguntaría a una IA y si el sitio lo cubre.
import type {
  SiteSignals,
  FetchedSite,
  SubScores,
  ScoreSnapshot,
  DetailedReport,
  CompetitorComparison,
  ClientQuestion,
  ExecutiveSummary,
} from './types';
import { validateAndNormalize } from './validate';
import { fetchSite } from './fetchSite';
import { parseHtml } from './parseHtml';
import { computeTechnical } from './technicalScore';
import { combineScores } from './score';
import { buildUserPrompt } from './contentShared';
import { callClaudeTool, evaluateWithClaude } from './claude';

const DEFAULT_DETAILED_MODEL = 'claude-haiku-4-5';
// Cota dura de competidores: cada uno hace ~4 subrequests (fetchSite) + 1 a Claude,
// y el worker tiene un tope de ~50 subrequests. 3 deja amplio margen.
const MAX_COMPETITORS = 3;

export interface BuildDetailedReportArgs {
  signals: SiteSignals;
  site: FetchedSite;
  competitors: string[];
  env: Env;
}

export async function buildDetailedReport(args: BuildDetailedReportArgs): Promise<DetailedReport> {
  const model = args.env.DETAILED_MODEL || DEFAULT_DETAILED_MODEL;
  const generatedAt = new Date().toISOString();

  // Las tres secciones degradan por separado: cada promesa atrapa su propio error
  // para que el fallo de una NO tumbe el informe completo.
  const [competitorSection, clientQuestions, executiveSummary] = await Promise.all([
    buildCompetitorSection(args, model).catch((err) => {
      console.error('detailed: competidores falló', err);
      return { competitors: null, competitorsSummary: null, clientComparison: null };
    }),
    buildClientQuestions(args, model).catch((err) => {
      console.error('detailed: preguntas-cliente falló', err);
      return null;
    }),
    buildExecutiveSummary(args, model).catch((err) => {
      console.error('detailed: resumen ejecutivo falló', err);
      return null;
    }),
  ]);

  return {
    competitors: competitorSection.competitors,
    competitorsSummary: competitorSection.competitorsSummary,
    clientComparison: competitorSection.clientComparison,
    clientQuestions,
    executiveSummary,
    generatedAt,
  };
}

// --- Resumen ejecutivo (sección 0 del informe detallado) ---
// 1 call a Claude que produce 3 fortalezas + 3 brechas + veredicto de una
// línea. Es lo primero que se lee en el reporte PDF — tiene que picar.
const SUMMARY_SYSTEM = `Eres un consultor GEO senior. Dado el puntaje (0-100), los subpuntajes, las verificaciones técnicas y las recomendaciones de un sitio, escribe un RESUMEN EJECUTIVO en español, en lenguaje de NEGOCIO (sin jerga técnica).

Devuelve EXACTAMENTE este JSON:
{
  "strengths": ["...", "...", "..."],   // 3 frases cortas sobre lo que YA está bien (impacto en el negocio, no técnico)
  "gaps":      ["...", "...", "..."],   // 3 frases cortas sobre lo que falta (impacto en el negocio)
  "verdict":   "..."                    // 1 frase de cierre, directa, en lenguaje de dueño de negocio
}

Reglas:
- Cada strength/gap es 1 frase de 10-25 palabras.
- strengths van primero (lo que el dueño puede mostrar con orgullo), gaps después (lo que tiene que resolver).
- Si los bots de IA están bloqueados, el primer gap DEBE ser ese.
- PROHIBIDO usar jerga técnica: "JSON-LD", "schema", "meta", "robots.txt", "canonical", "sitemap", "H1", etc.
- Basa todo SOLO en los datos entregados, no inventes.`;

const SUMMARY_TOOL_NAME = 'resumen_ejecutivo_geo';
const SUMMARY_TOOL_DESCRIPTION =
  'Devuelve 3 fortalezas, 3 brechas y 1 veredicto para el resumen ejecutivo de un reporte GEO.';
const SUMMARY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    strengths: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['strengths', 'gaps', 'verdict'],
};

async function buildExecutiveSummary(
  args: BuildDetailedReportArgs,
  model: string
): Promise<ExecutiveSummary | null> {
  const title = args.signals.title || hostnameOf(args.site.finalUrl) || 'el sitio';

  // Tomamos datos del análisis técnico ya calculado: puntaje final, subpuntajes
  // (re-evaluando con método manzana-con-manzana para que sea consistente con
  // la comparativa que aparece más adelante en el mismo reporte).
  const tech = computeTechnical(args.signals, args.site);
  const content = await evaluateWithClaude(args.signals, args.env);
  const { finalScore, subScores } = combineScores(tech, content);

  const lines: string[] = [
    `Sitio: ${title} (${args.site.finalUrl})`,
    `Puntaje final: ${finalScore}/100`,
    `Subpuntajes (0-100): técnico ${subScores.tecnico}, claridadNegocio ${subScores.claridadNegocio}, citabilidad ${subScores.citabilidad}, autoridad ${subScores.autoridad}, claridadGeografica ${subScores.claridadGeografica}`,
    '',
    'Verificaciones técnicas (passed/failed):',
  ];
  for (const c of tech.checks) {
    lines.push(`- [${c.passed ? 'OK' : 'FALTA'}] ${c.label} (${c.points}/${c.maxPoints} pts)`);
  }
  lines.push('', 'Recomendaciones de la IA:');
  if (content.recomendaciones.length) {
    for (const r of content.recomendaciones) lines.push(`- ${r}`);
  } else {
    lines.push('- (sin recomendaciones)');
  }

  const input = await callClaudeTool<{
    strengths?: unknown;
    gaps?: unknown;
    verdict?: unknown;
  }>({
    system: SUMMARY_SYSTEM,
    userPrompt: lines.join('\n'),
    toolName: SUMMARY_TOOL_NAME,
    toolDescription: SUMMARY_TOOL_DESCRIPTION,
    inputSchema: SUMMARY_INPUT_SCHEMA,
    env: args.env,
    model,
  });
  if (!input) return null;
  const strengths = Array.isArray(input.strengths)
    ? (input.strengths.filter((s) => typeof s === 'string') as string[]).slice(0, 3)
    : [];
  const gaps = Array.isArray(input.gaps)
    ? (input.gaps.filter((s) => typeof s === 'string') as string[]).slice(0, 3)
    : [];
  const verdict = typeof input.verdict === 'string' ? input.verdict.trim() : '';
  if (!strengths.length && !gaps.length && !verdict) return null;
  return {
    strengths: strengths.map((s) => s.trim()).filter(Boolean),
    gaps: gaps.map((s) => s.trim()).filter(Boolean),
    verdict,
  };
}

// --- Sección 1: comparación con competidores ---

function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

interface CompetitorTarget {
  url: string;
  origin: string;
  domain: string;
}

async function buildCompetitorSection(
  args: BuildDetailedReportArgs,
  model: string
): Promise<{
  competitors: CompetitorComparison[] | null;
  competitorsSummary: string | null;
  clientComparison: ScoreSnapshot | null;
}> {
  const ownDomain = hostnameOf(args.site.finalUrl);

  // Valida/normaliza cada URL; descarta inválidas, las del mismo dominio del cliente
  // y duplicadas; limita a MAX_COMPETITORS.
  const seen = new Set<string>();
  const targets: CompetitorTarget[] = [];
  for (const raw of args.competitors) {
    if (targets.length >= MAX_COMPETITORS) break;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const v = validateAndNormalize(raw, null);
    if (!v.ok) continue;
    if (ownDomain && v.data.domain === ownDomain) continue;
    if (seen.has(v.data.domain)) continue;
    seen.add(v.data.domain);
    targets.push({ url: v.data.url, origin: v.data.origin, domain: v.data.domain });
  }

  if (targets.length === 0) return { competitors: null, competitorsSummary: null, clientComparison: null };

  // En paralelo (sin latencia secuencial): los competidores + el puntaje del cliente
  // medido con el MISMO evaluador (Claude/Haiku) para que la tabla sea manzana-con-manzana.
  // Los que fallen entran con error/null y no rompen; si el cliente falla, queda null.
  const [settled, clientComparison] = await Promise.all([
    Promise.allSettled(targets.map((t) => scoreCompetitor(t, args.env))),
    scoreClientHomogeneous(args.signals, args.site, args.env).catch(() => null),
  ]);
  const competitors: CompetitorComparison[] = settled.map((res, i) =>
    res.status === 'fulfilled'
      ? res.value
      : { url: targets[i].url, domain: targets[i].domain, finalScore: null, subScores: null, error: 'scan-failed' }
  );

  // Síntesis: una sola llamada con SOLO los números/subscores y títulos (no el texto completo).
  const competitorsSummary = await synthesizeComparison(args, clientComparison, competitors, model);
  return { competitors, competitorsSummary, clientComparison };
}

async function scoreCompetitor(target: CompetitorTarget, env: Env): Promise<CompetitorComparison> {
  const site = await fetchSite(target.origin, target.url);
  if (!site.ok || !site.html) {
    return { url: target.url, domain: target.domain, finalScore: null, subScores: null, error: 'no-alcanzable' };
  }
  const signals = await parseHtml(site.html);
  // Mismo método EXACTO que el cliente (scoreClientHomogeneous), pero con fetch/parse propios.
  const { finalScore, subScores } = await scoreClientHomogeneous(signals, site, env);
  return { url: target.url, domain: target.domain, finalScore, subScores };
}

// Puntúa al cliente con el MISMO método que a los competidores (computeTechnical +
// evaluateWithClaude + combineScores), pero SIN re-descargar el sitio: ya tenemos
// signals y site del escaneo base. Si la IA degrada, combineScores cae a técnico-solo,
// igual que para los competidores → la tabla queda en la misma escala.
async function scoreClientHomogeneous(
  signals: SiteSignals,
  site: FetchedSite,
  env: Env
): Promise<ScoreSnapshot> {
  const tech = computeTechnical(signals, site);
  const content = await evaluateWithClaude(signals, env);
  const { finalScore, subScores } = combineScores(tech, content);
  return { finalScore, subScores };
}

const COMPARISON_SYSTEM = `Eres un consultor de negocio experto en GEO (visibilidad en motores de búsqueda generativos como ChatGPT, Perplexity y Google AI). Te doy el puntaje (0-100) y los subpuntajes del sitio de un cliente y de sus competidores. En 2 o 3 frases, en español y en lenguaje de DUEÑO DE NEGOCIO, explica dónde el cliente queda por detrás de sus competidores y qué debería priorizar para mejorar su visibilidad ante las IA.

REGLAS estrictas:
- Habla de impacto en el negocio, NO de implementación técnica.
- PROHIBIDO usar jerga técnica: "JSON-LD", "schema", "meta", "etiqueta", "H1", "canonical", "robots.txt", "sitemap".
- No inventes datos que no estén en los puntajes; básate solo en los números entregados.`;

const COMPARISON_TOOL_NAME = 'reportar_comparacion';
const COMPARISON_TOOL_DESCRIPTION = 'Devuelve la síntesis de negocio de la comparación con competidores.';
const COMPARISON_INPUT_SCHEMA = {
  type: 'object',
  properties: { sintesis: { type: 'string' } },
  required: ['sintesis'],
};

function describeSub(s: SubScores): string {
  return `preparación técnica ${s.tecnico}, claridad del negocio ${s.claridadNegocio}, facilidad para ser citado ${s.citabilidad}, autoridad ${s.autoridad}, claridad geográfica ${s.claridadGeografica}`;
}

async function synthesizeComparison(
  args: BuildDetailedReportArgs,
  client: ScoreSnapshot | null,
  competitors: CompetitorComparison[],
  model: string
): Promise<string | null> {
  const clientTitle = args.signals.title || hostnameOf(args.site.finalUrl) || 'el sitio del cliente';
  // Puntaje del cliente medido con el MISMO evaluador que los competidores (no el titular de Gemini).
  const clientLine =
    client && client.finalScore != null && client.subScores
      ? `Cliente "${clientTitle}" — puntaje ${client.finalScore}/100; subpuntajes: ${describeSub(client.subScores)}.`
      : `Cliente "${clientTitle}" — no se pudo evaluar con el mismo método.`;
  const lines: string[] = [
    clientLine,
    'Competidores:',
    ...competitors.map((c) =>
      c.finalScore == null || !c.subScores
        ? `- ${c.domain}: no se pudo evaluar.`
        : `- ${c.domain}: puntaje ${c.finalScore}/100; subpuntajes: ${describeSub(c.subScores)}.`
    ),
  ];

  const input = await callClaudeTool<{ sintesis?: unknown }>({
    system: COMPARISON_SYSTEM,
    userPrompt: lines.join('\n'),
    toolName: COMPARISON_TOOL_NAME,
    toolDescription: COMPARISON_TOOL_DESCRIPTION,
    inputSchema: COMPARISON_INPUT_SCHEMA,
    env: args.env,
    model,
  });
  const text = input && typeof input.sintesis === 'string' ? input.sintesis.trim() : '';
  return text || null;
}

// --- Sección 2: preguntas-cliente ---

const QUESTIONS_SYSTEM = `Eres experto en GEO. Dado el contenido de un sitio, genera entre 5 y 6 preguntas REALES que un cliente del rubro le haría a una IA, y evalúa si el sitio tiene información clara para que una IA pudiera responder citándolo. NO afirmes qué responde ChatGPT u otra IA; evalúa SOLO el contenido recibido.

REGLAS estrictas:
- En español, en lenguaje de DUEÑO DE NEGOCIO (no técnico).
- PROHIBIDO usar jerga técnica: "JSON-LD", "schema", "meta", "etiqueta", "H1", "canonical", "robots.txt", "sitemap".
- "cubierta" es true solo si el contenido recibido permitiría a una IA responder esa pregunta citando al sitio.
- "nota" explica en lenguaje de negocio por qué sí o por qué no está cubierta.`;

const QUESTIONS_TOOL_NAME = 'reportar_preguntas_cliente';
const QUESTIONS_TOOL_DESCRIPTION = 'Devuelve las preguntas-cliente y si el sitio las cubre.';
const QUESTIONS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    preguntas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pregunta: { type: 'string' },
          cubierta: { type: 'boolean' },
          nota: { type: 'string' },
        },
        required: ['pregunta', 'cubierta', 'nota'],
      },
    },
  },
  required: ['preguntas'],
};

async function buildClientQuestions(
  args: BuildDetailedReportArgs,
  model: string
): Promise<ClientQuestion[] | null> {
  const input = await callClaudeTool<{ preguntas?: unknown }>({
    system: QUESTIONS_SYSTEM,
    userPrompt: buildUserPrompt(args.signals),
    toolName: QUESTIONS_TOOL_NAME,
    toolDescription: QUESTIONS_TOOL_DESCRIPTION,
    inputSchema: QUESTIONS_INPUT_SCHEMA,
    env: args.env,
    model,
  });
  if (!input || !Array.isArray(input.preguntas)) return null;

  const questions: ClientQuestion[] = input.preguntas
    .filter((q: any) => q && typeof q.pregunta === 'string' && typeof q.nota === 'string')
    .map((q: any) => ({ pregunta: q.pregunta.trim(), cubierta: !!q.cubierta, nota: q.nota.trim() }))
    .filter((q: ClientQuestion) => q.pregunta.length > 0);

  return questions.length ? questions : null;
}
