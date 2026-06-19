// Gating del resultado: separa el "teaser" (gratis) del "full" (recomendaciones)
// y del "detailed" (informe de pago). Único punto de decisión de acceso → fácil
// de cambiar para cobrar en el futuro (hoy 'detailed' se desbloquea con passphrase).
import type { ScanResult, AccessLevel } from './types';

// Re-exporta AccessLevel para que los consumidores del gating lo importen desde aquí.
export type { AccessLevel } from './types';

/** Flujo de revelación en la UI. */
export type RevealFlow = 'one-step' | 'two-step';

export interface EntitlementInput {
  email: string | null;
  passphrase?: string | null; // desbloqueo del informe detallado (de pago)
  // FUTURO (cobro por uso): unlockToken?: string;  // token de pago/suscripción
}

/**
 * Decide si el usuario tiene acceso al detalle completo ("full").
 * HOY: entregar un email válido desbloquea las recomendaciones.
 * Se mantiene por compatibilidad; el ruteo nuevo usa accessLevel().
 */
export function isEntitled(input: EntitlementInput): boolean {
  return !!input.email;
}

/**
 * Nivel de acceso del request:
 *  - 'detailed' si la passphrase coincide con la configurada (informe de pago).
 *  - 'full'     si hay email válido (desbloquea recomendaciones + técnico).
 *  - 'teaser'   en cualquier otro caso.
 */
export function accessLevel(input: EntitlementInput, validPassphrase: string | null): AccessLevel {
  const provided = input.passphrase?.trim();
  const expected = validPassphrase?.trim();
  if (provided && expected && provided === expected) return 'detailed';
  if (input.email) return 'full';
  return 'teaser';
}

/**
 * Proyecta el resultado completo a lo que se envía al cliente, según el nivel.
 * El gating vive en el servidor, así que el cliente nunca recibe lo que no desbloqueó.
 *  - 'teaser'   → oculta recomendaciones, detalle técnico y el informe detallado.
 *  - 'full'     → recomendaciones y técnico visibles; sin informe detallado.
 *  - 'detailed' → como 'full' + el informe detallado (que ya viene en `full`).
 * En todos los casos sella el campo accessLevel del objeto devuelto.
 */
export function projectForClient(full: ScanResult, level: AccessLevel): ScanResult {
  if (level === 'teaser') {
    return {
      ...full,
      accessLevel: 'teaser',
      locked: true,
      recommendations: null,
      technicalChecks: null,
      detailedReport: null,
    };
  }
  if (level === 'full') {
    return {
      ...full,
      accessLevel: 'full',
      locked: false,
      detailedReport: null,
    };
  }
  // detailed: recomendaciones + técnico + informe detallado (el que computó scan.ts).
  return {
    ...full,
    accessLevel: 'detailed',
    locked: false,
  };
}
