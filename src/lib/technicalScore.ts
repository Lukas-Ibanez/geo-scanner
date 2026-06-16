// Checks técnicos deterministas (sin gastar IA) → puntaje técnico 0-100.
import type { SiteSignals, FetchedSite, TechnicalCheck, TechnicalResult } from './types';

// Bots de IA cuyo bloqueo en robots.txt es crítico para la visibilidad en GEO.
const AI_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Google-Extended',
];

// Tipos de schema.org que aportan más contexto de negocio a la IA.
const RICH_LD = /(Organization|LocalBusiness|Product|FAQPage|Service|Restaurant|Store|ProfessionalService|Article|Event|Review)/i;

interface RobotsGroup {
  agents: string[];
  rules: { type: 'allow' | 'disallow'; path: string }[];
}

function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      // Varios User-agent consecutivos comparten el mismo grupo de reglas.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'disallow' || field === 'allow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: field, path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function isBotBlocked(groups: RobotsGroup[], bot: string): boolean {
  const b = bot.toLowerCase();
  // El bot usa su grupo específico si existe; si no, el grupo '*'.
  let group = groups.find((g) => g.agents.includes(b));
  if (!group) group = groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  const disallowRoot = group.rules.some((r) => r.type === 'disallow' && r.path === '/');
  const allowRoot = group.rules.some((r) => r.type === 'allow' && r.path === '/');
  return disallowRoot && !allowRoot;
}

export function computeTechnical(signals: SiteSignals, site: FetchedSite): TechnicalResult {
  const checks: TechnicalCheck[] = [];

  // 1) robots.txt vs bots de IA — lo más crítico (25 pts).
  const groups = parseRobots(site.robotsTxt || '');
  const blockedBots = AI_BOTS.filter((bot) => isBotBlocked(groups, bot));
  const blocksAi = blockedBots.length > 0;
  checks.push({
    id: 'ai-bots',
    label: blocksAi
      ? `Tu sitio le impide la entrada a los robots de IA (${blockedBots.join(', ')}); hoy no pueden leerte.`
      : 'Los robots de las IA tienen permiso para leer tu sitio.',
    passed: !blocksAi,
    critical: true,
    points: blocksAi ? 0 : 25,
    maxPoints: 25,
  });

  // 2) Datos estructurados (15 pts; menos si faltan los tipos clave).
  const hasRich = signals.jsonLdTypes.some((t) => RICH_LD.test(t));
  checks.push({
    id: 'structured-data',
    label: signals.hasJsonLd
      ? hasRich
        ? 'Le entrega a la IA datos estructurados que describen tu negocio.'
        : 'Tiene algunos datos estructurados, pero faltan los que describen tu negocio o producto.'
      : 'No le explica a la IA, de forma estructurada, qué tipo de negocio eres.',
    passed: signals.hasJsonLd,
    points: signals.hasJsonLd ? (hasRich ? 15 : 10) : 0,
    maxPoints: 15,
  });

  // 3) Título de página (12 pts).
  const titleLen = signals.title?.trim().length ?? 0;
  const titleOk = titleLen >= 10 && titleLen <= 70;
  checks.push({
    id: 'title',
    label: titleOk
      ? 'Tiene un título de página claro y de buen largo.'
      : signals.title
        ? 'El título de la página es muy corto o muy largo para describir bien tu negocio.'
        : 'La página no tiene un título que la IA pueda usar para identificarte.',
    passed: titleOk,
    points: titleOk ? 12 : signals.title ? 6 : 0,
    maxPoints: 12,
  });

  // 4) Descripción (12 pts).
  const descLen = signals.metaDescription?.trim().length ?? 0;
  const descOk = descLen >= 50 && descLen <= 170;
  checks.push({
    id: 'meta-description',
    label: descOk
      ? 'Tiene una descripción breve que resume de qué trata el sitio.'
      : signals.metaDescription
        ? 'La descripción del sitio es demasiado corta o demasiado larga.'
        : 'Falta una descripción breve que resuma qué ofreces.',
    passed: descOk,
    points: descOk ? 12 : signals.metaDescription ? 6 : 0,
    maxPoints: 12,
  });

  // 5) Encabezado principal único (12 pts).
  const h1Count = signals.h1.length;
  const h1Ok = h1Count === 1 && (signals.h1[0]?.trim().length ?? 0) >= 3;
  checks.push({
    id: 'h1',
    label: h1Ok
      ? 'Tiene un encabezado principal claro y único.'
      : h1Count === 0
        ? 'No tiene un encabezado principal que diga de qué trata la página.'
        : 'Tiene varios encabezados principales, lo que confunde sobre el tema central.',
    passed: h1Ok,
    points: h1Ok ? 12 : h1Count > 0 ? 6 : 0,
    maxPoints: 12,
  });

  // 6) Open Graph (8 pts).
  const ogOk = !!signals.ogTitle && !!signals.ogDescription;
  checks.push({
    id: 'open-graph',
    label: ogOk
      ? 'Está preparado para verse y citarse bien cuando lo comparten.'
      : 'Le faltan datos para mostrarse correctamente cuando lo comparten o lo cita una IA.',
    passed: ogOk,
    points: ogOk ? 8 : 0,
    maxPoints: 8,
  });

  // 7) Canonical (6 pts).
  checks.push({
    id: 'canonical',
    label: signals.canonical
      ? 'Indica cuál es la versión oficial de la página.'
      : 'No indica cuál es la versión oficial de cada página, lo que puede dispersar tu contenido.',
    passed: !!signals.canonical,
    points: signals.canonical ? 6 : 0,
    maxPoints: 6,
  });

  // 8) sitemap.xml (5 pts).
  checks.push({
    id: 'sitemap',
    label: site.sitemapExists
      ? 'Tiene un mapa del sitio que ayuda a descubrir todas sus páginas.'
      : 'No tiene un mapa del sitio (sitemap) que liste sus páginas.',
    passed: site.sitemapExists,
    points: site.sitemapExists ? 5 : 0,
    maxPoints: 5,
  });

  // 9) llms.txt (5 pts, bonus emergente).
  checks.push({
    id: 'llms-txt',
    label: site.llmsTxt
      ? 'Incluye un archivo llms.txt, una guía pensada para las IA. ¡Muy bien!'
      : 'No incluye llms.txt, el archivo emergente que orienta a las IA sobre tu contenido.',
    passed: !!site.llmsTxt,
    points: site.llmsTxt ? 5 : 0,
    maxPoints: 5,
  });

  let score = checks.reduce((sum, c) => sum + c.points, 0);
  // Si bloquea a los bots de IA, todo lo demás es secundario: techo bajo.
  if (blocksAi) score = Math.min(score, 30);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, checks, blocksAiBots: blocksAi };
}
