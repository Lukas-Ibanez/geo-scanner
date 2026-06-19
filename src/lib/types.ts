// Tipos compartidos del flujo de escaneo.

/** Señales extraídas del HTML del sitio. */
export interface SiteSignals {
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  h2: string[];
  h3: string[];
  hasJsonLd: boolean;
  jsonLdTypes: string[];
  ogTitle: string | null;
  ogDescription: string | null;
  canonical: string | null;
  lang: string | null;
  /** Texto visible principal, truncado (~3.000 palabras / ~24k chars). */
  mainText: string;
  wordCount: number;
}

/** Resultado de descargar el sitio + sus archivos auxiliares. */
export interface FetchedSite {
  ok: boolean;
  status: number;
  html: string;
  finalUrl: string;
  robotsTxt: string | null;
  llmsTxt: string | null;
  sitemapExists: boolean;
}

/** Un check técnico individual, con etiqueta en lenguaje de negocio. */
export interface TechnicalCheck {
  id: string;
  label: string;
  passed: boolean;
  critical?: boolean;
  points: number;
  maxPoints: number;
}

export interface TechnicalResult {
  score: number; // 0-100
  checks: TechnicalCheck[];
  blocksAiBots: boolean;
}

/** Resultado del análisis de contenido con IA (o degradado). */
export interface ContentResult {
  available: boolean; // false = Gemini falló/cuota agotada → degradado
  claridadNegocio: number;
  citabilidad: number;
  autoridad: number;
  claridadGeografica: number;
  recomendaciones: string[];
  debug?: string; // motivo del degradado (diagnóstico)
}

export interface SubScores {
  tecnico: number;
  claridadNegocio: number;
  citabilidad: number;
  autoridad: number;
  claridadGeografica: number;
}

/** Nivel de acceso al resultado: gratis (teaser), con email (full), de pago (detailed). */
export type AccessLevel = 'teaser' | 'full' | 'detailed';

/** Un competidor evaluado con el mismo método que el cliente. */
export interface CompetitorComparison {
  url: string;
  domain: string;
  finalScore: number | null; // null si no se pudo evaluar (ver `error`)
  subScores: SubScores | null;
  error?: string;
}

/** Una pregunta-cliente y si el sitio tiene contenido para que una IA la responda citándolo. */
export interface ClientQuestion {
  pregunta: string;
  cubierta: boolean;
  nota: string;
}

/**
 * Informe detallado (nivel 'detailed'): análisis que el escaneo gratis no hace.
 * Cada sección degrada por separado (null) sin romper el resto del informe.
 */
export interface DetailedReport {
  competitors: CompetitorComparison[] | null;
  competitorsSummary: string | null;
  clientQuestions: ClientQuestion[] | null;
  generatedAt: string; // ISO
}

/**
 * Resultado completo de un escaneo. Es lo que se cachea en KV.
 * Lo que se envía al cliente es una proyección (ver entitlement.projectForClient):
 * los campos "gated" (recommendations, technicalChecks) se ocultan si no hay acceso.
 */
export interface ScanResult {
  url: string;
  domain: string;
  scannedAt: string; // ISO
  fromCache: boolean;
  accessLevel: AccessLevel; // nivel con el que se proyectó al cliente

  // --- teaser (siempre visible) ---
  finalScore: number; // 0-100
  verdict: string;
  subScores: SubScores;
  aiAnalysisAvailable: boolean;
  blocksAiBots: boolean;
  recommendationsCount: number;
  technicalSummary: { passed: number; total: number };

  // --- full (gated) ---
  locked: boolean;
  recommendations: string[] | null;
  technicalChecks: TechnicalCheck[] | null;

  // --- detailed (gated, de pago) ---
  detailedReport: DetailedReport | null;
}
