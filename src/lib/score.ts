// Combinación del puntaje técnico (40%) y de contenido (60%) → final + veredicto.
import type { TechnicalResult, ContentResult, SubScores } from './types';

export interface CombinedScore {
  finalScore: number;
  subScores: SubScores;
  verdict: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function combineScores(tech: TechnicalResult, content: ContentResult): CombinedScore {
  let finalScore: number;
  if (content.available) {
    const contentAvg =
      (content.claridadNegocio + content.citabilidad + content.autoridad + content.claridadGeografica) / 4;
    finalScore = clamp(tech.score * 0.4 + contentAvg * 0.6);
  } else {
    // Degradado: sin IA, el puntaje final es solo el técnico.
    finalScore = clamp(tech.score);
  }

  const subScores: SubScores = {
    tecnico: tech.score,
    claridadNegocio: content.available ? clamp(content.claridadNegocio) : 0,
    citabilidad: content.available ? clamp(content.citabilidad) : 0,
    autoridad: content.available ? clamp(content.autoridad) : 0,
    claridadGeografica: content.available ? clamp(content.claridadGeografica) : 0,
  };

  return { finalScore, subScores, verdict: buildVerdict(finalScore, tech, content) };
}

function buildVerdict(score: number, tech: TechnicalResult, content: ContentResult): string {
  if (tech.blocksAiBots) {
    return 'Tu sitio está bloqueando a los robots de IA: hoy, herramientas como ChatGPT o Google AI no pueden leerlo para recomendarte.';
  }

  let base: string;
  if (score >= 80) {
    base = 'Tu sitio está bien preparado para aparecer en respuestas de IA; quedan solo detalles por pulir.';
  } else if (score >= 60) {
    base = 'Tu sitio tiene una base decente, pero hay vacíos que reducen tus chances de aparecer en ChatGPT o Google AI.';
  } else if (score >= 40) {
    base = 'Las IA tienen dificultad para entender qué ofreces y dónde operas; estás perdiendo oportunidades de aparecer en sus respuestas.';
  } else {
    base = 'Hoy es muy poco probable que una IA recomiende tu sitio: no logra entender bien qué haces ni para quién.';
  }

  if (content.available) {
    const weakest = weakestArea(content);
    if (weakest) base += ` ${weakest}`;
  }
  return base;
}

function weakestArea(content: ContentResult): string | null {
  const areas = [
    { v: content.claridadNegocio, msg: 'Lo más débil: no queda claro qué servicio o producto ofreces.' },
    { v: content.claridadGeografica, msg: 'Lo más débil: no se entiende bien en qué ciudad o zona operas.' },
    { v: content.citabilidad, msg: 'Lo más débil: tu contenido es difícil de citar para una IA.' },
    { v: content.autoridad, msg: 'Lo más débil: faltan señales de experiencia y confianza.' },
  ];
  areas.sort((a, b) => a.v - b.v);
  const worst = areas[0];
  return worst && worst.v < 60 ? worst.msg : null;
}
