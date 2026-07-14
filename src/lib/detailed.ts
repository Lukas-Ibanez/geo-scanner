// Informe detallado (nivel 'detailed', de pago): análisis que el escaneo gratis
// no hace. Solo usa Claude (callClaudeTool) — sin web search ni otras IAs.
//
// Estructura (cada bloque degrada por separado sin romper el resto):
//   0) Núcleo premium (UNA llamada a Sonnet): resumen ejecutivo + diagnóstico
//      por dimensión + plan de acción priorizado + "cómo te ven las IA hoy".
//   1) Comparación con competidores (tabla manzana-con-manzana + síntesis +
//      en qué te gana cada competidor concretamente).
//   2) Preguntas-cliente: qué le preguntaría a una IA y si el sitio lo cubre.
//
// División de modelos: la PROSA del informe usa Sonnet (DETAILED_MODEL) porque
// es lo que el cliente paga; el SCORING (evaluateWithClaude) sigue en el modelo
// de contenido (Haiku) para que los puntajes sean baratos y consistentes entre
// cliente y competidores.
import type {
  SiteSignals,
  FetchedSite,
  SubScores,
  ScoreSnapshot,
  DetailedReport,
  CompetitorComparison,
  CompetitorInsight,
  ClientQuestion,
  ExecutiveSummary,
  DimensionDiagnosis,
  ActionItem,
  TechnicalResult,
  ContentResult,
} from './types';
import { validateAndNormalize } from './validate';
import { fetchSite } from './fetchSite';
import { parseHtml } from './parseHtml';
import { computeTechnical } from './technicalScore';
import { combineScores } from './score';
import { buildUserPrompt } from './contentShared';
import { callClaudeTool, evaluateWithClaude } from './claude';

// Sonnet 4.6: calidad de consultor senior para el informe que el cliente paga.
// El costo (~US$0,15-0,40/reporte) se absorbe de sobra en el precio.
const DEFAULT_DETAILED_MODEL = 'claude-sonnet-4-6';
// Cota dura de competidores: cada uno hace ~4 subrequests (fetchSite) + 1 a Claude,
// y el worker tiene un tope de ~50 subrequests. 3 deja amplio margen.
const MAX_COMPETITORS = 3;
// El núcleo premium produce un JSON grande (resumen + 5 diagnósticos + 5-8
// acciones + percepción) → más tokens y más tiempo que las llamadas chicas.
const PREMIUM_MAX_TOKENS = 4096;
const PREMIUM_TIMEOUT_MS = 60000;

export interface BuildDetailedReportArgs {
  signals: SiteSignals;
  site: FetchedSite;
  competitors: string[];
  env: Env;
}

/** Evaluación homogénea del cliente (misma vara que los competidores), hecha UNA vez. */
interface ClientEval {
  snapshot: ScoreSnapshot;
  tech: TechnicalResult;
  content: ContentResult;
}

export async function buildDetailedReport(args: BuildDetailedReportArgs): Promise<DetailedReport> {
  const model = args.env.DETAILED_MODEL || DEFAULT_DETAILED_MODEL;
  const generatedAt = new Date().toISOString();

  // El puntaje homogéneo del cliente se calcula UNA sola vez y lo comparten el
  // núcleo premium y la comparativa (antes se pagaban dos evaluaciones idénticas).
  const clientEval = await evaluateClient(args).catch((err) => {
    console.error('detailed: evaluación homogénea del cliente falló', err);
    return null;
  });

  // Los tres bloques degradan por separado: cada promesa atrapa su propio error
  // para que el fallo de uno NO tumbe el informe completo.
  const [core, competitorSection, clientQuestions] = await Promise.all([
    buildPremiumCore(args, model, clientEval).catch((err) => {
      console.error('detailed: núcleo premium falló', err);
      return null;
    }),
    buildCompetitorSection(args, model, clientEval).catch((err) => {
      console.error('detailed: competidores falló', err);
      return {
        competitors: null,
        competitorsSummary: null,
        competitorInsights: null,
        clientComparison: null,
      };
    }),
    buildClientQuestions(args, model).catch((err) => {
      console.error('detailed: preguntas-cliente falló', err);
      return null;
    }),
  ]);

  return {
    competitors: competitorSection.competitors,
    competitorsSummary: competitorSection.competitorsSummary,
    competitorInsights: competitorSection.competitorInsights,
    clientComparison: competitorSection.clientComparison,
    clientQuestions,
    executiveSummary: core?.executiveSummary ?? null,
    dimensionDiagnosis: core?.dimensionDiagnosis ?? null,
    actionPlan: core?.actionPlan ?? null,
    aiPerception: core?.aiPerception ?? null,
    generatedAt,
  };
}

// Puntúa al cliente con el MISMO método que a los competidores (computeTechnical +
// evaluateWithClaude + combineScores), pero SIN re-descargar el sitio: ya tenemos
// signals y site del escaneo base. Si la IA degrada, combineScores cae a técnico-solo,
// igual que para los competidores → la tabla queda en la misma escala.
async function evaluateClient(args: BuildDetailedReportArgs): Promise<ClientEval> {
  const tech = computeTechnical(args.signals, args.site);
  const content = await evaluateWithClaude(args.signals, args.env);
  const { finalScore, subScores } = combineScores(tech, content);
  return { snapshot: { finalScore, subScores, aiAvailable: content.available }, tech, content };
}

// --- Núcleo premium (sección 0 del informe detallado) ---
// UNA llamada a Sonnet que produce las cuatro piezas de consultoría del reporte.
// Van juntas a propósito: comparten todo el contexto (contenido del sitio +
// puntajes + checks) y así el diagnóstico, el plan y el resumen no se contradicen.

interface PremiumCore {
  executiveSummary: ExecutiveSummary | null;
  dimensionDiagnosis: DimensionDiagnosis[] | null;
  actionPlan: ActionItem[] | null;
  aiPerception: string | null;
}

const DIMENSION_KEYS: Array<keyof SubScores> = [
  'tecnico',
  'claridadNegocio',
  'citabilidad',
  'autoridad',
  'claridadGeografica',
];

const PREMIUM_SYSTEM = `Eres un consultor GEO senior (visibilidad en motores de búsqueda generativos: ChatGPT, Perplexity, Google AI). Un dueño de negocio pagó por este informe: tiene que sentirse hecho a la medida de SU negocio, no una plantilla.

Recibirás el contenido de su sitio, su puntaje (0-100), los subpuntajes por dimensión, las verificaciones técnicas y recomendaciones previas. Con eso produce CUATRO piezas:

1) "resumen": el resumen ejecutivo.
   - "strengths": 3 frases (10-25 palabras) sobre lo que YA está bien, con impacto en el negocio.
   - "gaps": 3 frases (10-25 palabras) sobre lo que falta. Si los bots de IA están bloqueados, el primer gap DEBE ser ese.
   - "verdict": 1 frase de cierre, directa, en lenguaje de dueño de negocio.

2) "dimensiones": diagnóstico de las 5 dimensiones (tecnico, claridadNegocio, citabilidad, autoridad, claridadGeografica). Por cada una:
   - "lectura": qué dice ese puntaje sobre ESTE negocio en concreto (menciona su rubro, sus servicios, su ciudad si aparecen). 1-2 frases. NADA genérico.
   - "implicancia": qué le cuesta al negocio dejarlo como está (clientes que no llegan, competidores que aparecen en su lugar). 1 frase.

3) "plan": plan de acción priorizado de 5 a 8 acciones. Por cada una:
   - "accion": QUÉ lograr, en imperativo y concreto al negocio (ej: "Publica los precios de tus 3 servicios principales"). PROHIBIDO explicar el CÓMO técnico (nada de instrucciones, código ni pasos de implementación): este informe dice qué hacer; la implementación es un servicio aparte.
   - "porQue": qué gana el negocio al hacerlo (1 frase).
   - "impacto": "alto" | "medio" | "bajo" — cuánto mueve la visibilidad ante las IA.
   - "esfuerzo": "bajo" | "medio" | "alto" — cuánto trabajo toma.
   - "plazo": "esta semana" | "este mes" | "1-3 meses".
   - Ordena por impacto (alto primero); ante empate, menor esfuerzo primero.

4) "percepcionIA": 2-4 frases que describan cómo entendería HOY este negocio una IA que lea su sitio: qué diría que hace, para quién y dónde, y qué se le quedaría afuera o confuso. Redáctalo como si la IA describiera el negocio a un usuario que pide una recomendación.

REGLAS GLOBALES:
- Todo en español, en lenguaje de DUEÑO DE NEGOCIO.
- PROHIBIDA la jerga técnica: "JSON-LD", "schema", "meta", "etiqueta", "H1", "canonical", "robots.txt", "sitemap", "HTML". Di "los robots de IA", "la información estructurada de tu sitio", "los textos de presentación", etc.
- Basa TODO en los datos entregados. No inventes cifras, servicios ni competidores.
- Sé específico: nombra los servicios, el rubro y la zona del cliente cuando el contenido los revele.`;

const PREMIUM_TOOL_NAME = 'informe_premium_geo';
const PREMIUM_TOOL_DESCRIPTION =
  'Devuelve el núcleo del informe GEO premium: resumen ejecutivo, diagnóstico por dimensión, plan de acción y percepción de las IA.';
const PREMIUM_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    resumen: {
      type: 'object',
      properties: {
        strengths: { type: 'array', items: { type: 'string' } },
        gaps: { type: 'array', items: { type: 'string' } },
        verdict: { type: 'string' },
      },
      required: ['strengths', 'gaps', 'verdict'],
    },
    dimensiones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: DIMENSION_KEYS },
          lectura: { type: 'string' },
          implicancia: { type: 'string' },
        },
        required: ['dimension', 'lectura', 'implicancia'],
      },
    },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          accion: { type: 'string' },
          porQue: { type: 'string' },
          impacto: { type: 'string', enum: ['alto', 'medio', 'bajo'] },
          esfuerzo: { type: 'string', enum: ['bajo', 'medio', 'alto'] },
          plazo: { type: 'string' },
        },
        required: ['accion', 'porQue', 'impacto', 'esfuerzo', 'plazo'],
      },
    },
    percepcionIA: { type: 'string' },
  },
  required: ['resumen', 'dimensiones', 'plan', 'percepcionIA'],
};

async function buildPremiumCore(
  args: BuildDetailedReportArgs,
  model: string,
  clientEval: ClientEval | null
): Promise<PremiumCore | null> {
  const title = args.signals.title || hostnameOf(args.site.finalUrl) || 'el sitio';

  // Si la evaluación homogénea falló (raro), reconstruimos lo determinista:
  // el técnico es local y gratis; el contenido queda sin recomendaciones.
  const tech = clientEval?.tech ?? computeTechnical(args.signals, args.site);
  const snapshot = clientEval?.snapshot ?? null;
  const recomendaciones = clientEval?.content.recomendaciones ?? [];

  const lines: string[] = [
    `Sitio: ${title} (${args.site.finalUrl})`,
    snapshot?.finalScore != null ? `Puntaje final: ${snapshot.finalScore}/100` : 'Puntaje final: (no disponible)',
  ];
  if (snapshot?.subScores) {
    const s = snapshot.subScores;
    lines.push(
      `Subpuntajes (0-100): tecnico ${s.tecnico}, claridadNegocio ${s.claridadNegocio}, citabilidad ${s.citabilidad}, autoridad ${s.autoridad}, claridadGeografica ${s.claridadGeografica}`
    );
  }
  lines.push('', 'Verificaciones técnicas (passed/failed):');
  for (const c of tech.checks) {
    lines.push(`- [${c.passed ? 'OK' : 'FALTA'}] ${c.label} (${c.points}/${c.maxPoints} pts)`);
  }
  lines.push('', 'Recomendaciones previas del análisis de contenido:');
  if (recomendaciones.length) {
    for (const r of recomendaciones) lines.push(`- ${r}`);
  } else {
    lines.push('- (sin recomendaciones previas)');
  }
  lines.push('', 'CONTENIDO DEL SITIO:', buildUserPrompt(args.signals));

  const input = await callClaudeTool<{
    resumen?: any;
    dimensiones?: unknown;
    plan?: unknown;
    percepcionIA?: unknown;
  }>({
    system: PREMIUM_SYSTEM,
    userPrompt: lines.join('\n'),
    toolName: PREMIUM_TOOL_NAME,
    toolDescription: PREMIUM_TOOL_DESCRIPTION,
    inputSchema: PREMIUM_INPUT_SCHEMA,
    env: args.env,
    model,
    maxTokens: PREMIUM_MAX_TOKENS,
    timeoutMs: PREMIUM_TIMEOUT_MS,
  });
  if (!input) return null;

  return {
    executiveSummary: parseExecutiveSummary(input.resumen),
    dimensionDiagnosis: parseDimensionDiagnosis(input.dimensiones),
    actionPlan: parseActionPlan(input.plan),
    aiPerception:
      typeof input.percepcionIA === 'string' && input.percepcionIA.trim()
        ? input.percepcionIA.trim()
        : null,
  };
}

function parseExecutiveSummary(raw: any): ExecutiveSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const strengths = Array.isArray(raw.strengths)
    ? (raw.strengths.filter((s: unknown) => typeof s === 'string') as string[])
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const gaps = Array.isArray(raw.gaps)
    ? (raw.gaps.filter((s: unknown) => typeof s === 'string') as string[])
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const verdict = typeof raw.verdict === 'string' ? raw.verdict.trim() : '';
  if (!strengths.length && !gaps.length && !verdict) return null;
  return { strengths, gaps, verdict };
}

function parseDimensionDiagnosis(raw: unknown): DimensionDiagnosis[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: DimensionDiagnosis[] = [];
  for (const d of raw as any[]) {
    if (!d || typeof d.lectura !== 'string' || typeof d.implicancia !== 'string') continue;
    if (!DIMENSION_KEYS.includes(d.dimension)) continue;
    if (seen.has(d.dimension)) continue;
    seen.add(d.dimension);
    out.push({
      dimension: d.dimension,
      lectura: d.lectura.trim(),
      implicancia: d.implicancia.trim(),
    });
  }
  return out.length ? out : null;
}

const IMPACTO_VALUES = new Set(['alto', 'medio', 'bajo']);
const ESFUERZO_VALUES = new Set(['bajo', 'medio', 'alto']);

function parseActionPlan(raw: unknown): ActionItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ActionItem[] = [];
  for (const a of raw as any[]) {
    if (!a || typeof a.accion !== 'string' || !a.accion.trim()) continue;
    out.push({
      accion: a.accion.trim(),
      porQue: typeof a.porQue === 'string' ? a.porQue.trim() : '',
      impacto: IMPACTO_VALUES.has(a.impacto) ? a.impacto : 'medio',
      esfuerzo: ESFUERZO_VALUES.has(a.esfuerzo) ? a.esfuerzo : 'medio',
      plazo: typeof a.plazo === 'string' && a.plazo.trim() ? a.plazo.trim() : 'este mes',
    });
    if (out.length >= 8) break;
  }
  return out.length ? out : null;
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

/** Perfil mínimo de un sitio para que la síntesis compare contenidos, no solo números. */
interface SiteProfile {
  domain: string;
  title: string | null;
  headings: string[];
}

function profileOf(domain: string, signals: SiteSignals): SiteProfile {
  return {
    domain,
    title: signals.title,
    headings: [...signals.h1, ...signals.h2].slice(0, 8),
  };
}

async function buildCompetitorSection(
  args: BuildDetailedReportArgs,
  model: string,
  clientEval: ClientEval | null
): Promise<{
  competitors: CompetitorComparison[] | null;
  competitorsSummary: string | null;
  competitorInsights: CompetitorInsight[] | null;
  clientComparison: ScoreSnapshot | null;
}> {
  const ownDomain = hostnameOf(args.site.finalUrl);
  const clientComparison = clientEval?.snapshot ?? null;

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

  if (targets.length === 0) {
    return { competitors: null, competitorsSummary: null, competitorInsights: null, clientComparison: null };
  }

  // En paralelo (sin latencia secuencial). Los que fallen entran con error/null y no rompen.
  const settled = await Promise.allSettled(targets.map((t) => scoreCompetitor(t, args.env)));
  const competitors: CompetitorComparison[] = settled.map((res, i) =>
    res.status === 'fulfilled'
      ? res.value.comparison
      : { url: targets[i].url, domain: targets[i].domain, finalScore: null, subScores: null, error: 'scan-failed' }
  );
  const profiles: SiteProfile[] = settled
    .filter((res): res is PromiseFulfilledResult<ScoredCompetitor> => res.status === 'fulfilled')
    .map((res) => res.value.profile);

  // Síntesis + insights por competidor: números + títulos/encabezados de cada
  // sitio para que el "en qué te ganan" sea concreto y no solo aritmético.
  const synthesis = await synthesizeComparison(args, clientComparison, competitors, profiles, model);
  return {
    competitors,
    competitorsSummary: synthesis?.sintesis ?? null,
    competitorInsights: synthesis?.insights ?? null,
    clientComparison,
  };
}

interface ScoredCompetitor {
  comparison: CompetitorComparison;
  profile: SiteProfile;
}

async function scoreCompetitor(target: CompetitorTarget, env: Env): Promise<ScoredCompetitor> {
  const site = await fetchSite(target.origin, target.url);
  if (!site.ok || !site.html) {
    return {
      comparison: { url: target.url, domain: target.domain, finalScore: null, subScores: null, error: 'no-alcanzable' },
      profile: { domain: target.domain, title: null, headings: [] },
    };
  }
  const signals = await parseHtml(site.html);
  // Mismo método EXACTO que el cliente (evaluateClient), pero con fetch/parse propios.
  const tech = computeTechnical(signals, site);
  const content = await evaluateWithClaude(signals, env);
  const { finalScore, subScores } = combineScores(tech, content);
  return {
    comparison: {
      url: target.url,
      domain: target.domain,
      finalScore,
      subScores,
      aiAvailable: content.available,
    },
    profile: profileOf(target.domain, signals),
  };
}

const COMPARISON_SYSTEM = `Eres un consultor de negocio experto en GEO (visibilidad en motores de búsqueda generativos como ChatGPT, Perplexity y Google AI). Te doy el puntaje (0-100), los subpuntajes y los títulos/encabezados del sitio de un cliente y de sus competidores.

Devuelve DOS cosas:
1) "sintesis": 2-4 frases en español que expliquen dónde el cliente queda por detrás de sus competidores y qué debería priorizar para que las IA lo recomienden más.
2) "insights": por cada competidor QUE SE PUDO EVALUAR, una entrada con:
   - "domain": el dominio del competidor tal como te lo entregué.
   - "queHacenMejor": 1-2 frases CONCRETAS sobre qué hace mejor ese competidor según sus puntajes y sus títulos/encabezados (ej: muestra sus servicios con nombres claros, deja explícita su zona, exhibe señales de experiencia), y qué de eso le conviene replicar primero al cliente. Si el competidor NO supera al cliente, dilo y destaca qué ventaja mantener.

REGLAS estrictas:
- Lenguaje de DUEÑO DE NEGOCIO; habla de impacto en el negocio, NO de implementación técnica.
- PROHIBIDO usar jerga técnica: "JSON-LD", "schema", "meta", "etiqueta", "H1", "canonical", "robots.txt", "sitemap", "HTML".
- No inventes datos: básate SOLO en los puntajes y en los títulos/encabezados entregados.`;

const COMPARISON_TOOL_NAME = 'reportar_comparacion';
const COMPARISON_TOOL_DESCRIPTION =
  'Devuelve la síntesis de negocio de la comparación con competidores y los insights por competidor.';
const COMPARISON_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    sintesis: { type: 'string' },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          queHacenMejor: { type: 'string' },
        },
        required: ['domain', 'queHacenMejor'],
      },
    },
  },
  required: ['sintesis', 'insights'],
};

function describeSub(s: SubScores, aiAvailable?: boolean): string {
  if (aiAvailable === false) {
    return `preparación técnica ${s.tecnico} (el contenido no se pudo evaluar: solo puntaje técnico)`;
  }
  return `preparación técnica ${s.tecnico}, claridad del negocio ${s.claridadNegocio}, facilidad para ser citado ${s.citabilidad}, autoridad ${s.autoridad}, claridad geográfica ${s.claridadGeografica}`;
}

function describeProfile(p: SiteProfile): string {
  const title = p.title ? `título "${p.title}"` : 'sin título visible';
  const heads = p.headings.length ? `encabezados: ${p.headings.map((h) => `"${h}"`).join(', ')}` : 'sin encabezados legibles';
  return `${title}; ${heads}`;
}

async function synthesizeComparison(
  args: BuildDetailedReportArgs,
  client: ScoreSnapshot | null,
  competitors: CompetitorComparison[],
  profiles: SiteProfile[],
  model: string
): Promise<{ sintesis: string | null; insights: CompetitorInsight[] | null } | null> {
  const clientTitle = args.signals.title || hostnameOf(args.site.finalUrl) || 'el sitio del cliente';
  const clientProfile = profileOf(hostnameOf(args.site.finalUrl) ?? 'cliente', args.signals);
  // Puntaje del cliente medido con el MISMO evaluador que los competidores (no el titular de Gemini).
  const clientLine =
    client && client.finalScore != null && client.subScores
      ? `Cliente "${clientTitle}" — puntaje ${client.finalScore}/100; subpuntajes: ${describeSub(client.subScores, client.aiAvailable)}; ${describeProfile(clientProfile)}.`
      : `Cliente "${clientTitle}" — no se pudo evaluar con el mismo método; ${describeProfile(clientProfile)}.`;
  const byDomain = new Map(profiles.map((p) => [p.domain, p]));
  const lines: string[] = [
    clientLine,
    'Competidores:',
    ...competitors.map((c) => {
      if (c.finalScore == null || !c.subScores) return `- ${c.domain}: no se pudo evaluar.`;
      const p = byDomain.get(c.domain);
      return `- ${c.domain}: puntaje ${c.finalScore}/100; subpuntajes: ${describeSub(c.subScores, c.aiAvailable)}${p ? `; ${describeProfile(p)}` : ''}.`;
    }),
  ];

  const input = await callClaudeTool<{ sintesis?: unknown; insights?: unknown }>({
    system: COMPARISON_SYSTEM,
    userPrompt: lines.join('\n'),
    toolName: COMPARISON_TOOL_NAME,
    toolDescription: COMPARISON_TOOL_DESCRIPTION,
    inputSchema: COMPARISON_INPUT_SCHEMA,
    env: args.env,
    model,
  });
  if (!input) return null;

  const sintesis = typeof input.sintesis === 'string' && input.sintesis.trim() ? input.sintesis.trim() : null;
  const validDomains = new Set(competitors.filter((c) => c.finalScore != null).map((c) => c.domain));
  const insights: CompetitorInsight[] = Array.isArray(input.insights)
    ? (input.insights as any[])
        .filter(
          (i) =>
            i &&
            typeof i.domain === 'string' &&
            typeof i.queHacenMejor === 'string' &&
            i.queHacenMejor.trim() &&
            validDomains.has(i.domain.trim().toLowerCase())
        )
        .map((i) => ({ domain: i.domain.trim().toLowerCase(), queHacenMejor: i.queHacenMejor.trim() }))
        .slice(0, MAX_COMPETITORS)
    : [];
  return { sintesis, insights: insights.length ? insights : null };
}

// --- Sección 2: preguntas-cliente ---

const QUESTIONS_SYSTEM = `Eres experto en GEO. Dado el contenido de un sitio, genera entre 6 y 8 preguntas REALES que un cliente del rubro le haría a una IA, y evalúa si el sitio tiene información clara para que una IA pudiera responder citándolo. NO afirmes qué responde ChatGPT u otra IA; evalúa SOLO el contenido recibido.

Cubre una mezcla: preguntas de intención de compra ("¿cuánto cuesta...?", "¿quién hace... en [zona]?"), de confianza ("¿es confiable...?", "¿qué experiencia tiene...?") y de proceso ("¿cómo trabajan...?", "¿qué incluye...?").

REGLAS estrictas:
- En español, en lenguaje de DUEÑO DE NEGOCIO (no técnico).
- PROHIBIDO usar jerga técnica: "JSON-LD", "schema", "meta", "etiqueta", "H1", "canonical", "robots.txt", "sitemap".
- "cubierta" es true solo si el contenido recibido permitiría a una IA responder esa pregunta citando al sitio.
- "nota" explica en lenguaje de negocio por qué sí o por qué no está cubierta, y si no lo está, qué información debería existir para cubrirla (QUÉ agregar, no CÓMO implementarlo).`;

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
