// Gating del resultado: separa el "teaser" (gratis) del "full" (recomendaciones).
// Único punto de decisión de acceso → fácil de cambiar para cobrar en el futuro.
import type { ScanResult } from './types';

/** Flujo de revelación en la UI. */
export type RevealFlow = 'one-step' | 'two-step';

export interface EntitlementInput {
  email: string | null;
  // FUTURO (cobro por uso): unlockToken?: string;  // token de pago/suscripción
}

/**
 * Decide si el usuario tiene acceso al detalle completo ("full").
 * HOY: entregar un email válido desbloquea las recomendaciones.
 * FUTURO: cambiar SOLO esta función para exigir un pago verificado.
 */
export function isEntitled(input: EntitlementInput): boolean {
  return !!input.email;
}

/**
 * Proyecta el resultado completo a lo que se envía al cliente.
 * Sin entitlement, oculta recomendaciones y detalle técnico: el gating vive en
 * el servidor, así que el cliente nunca recibe lo que no desbloqueó.
 */
export function projectForClient(full: ScanResult, entitled: boolean): ScanResult {
  if (entitled) {
    return { ...full, locked: false };
  }
  return {
    ...full,
    locked: true,
    recommendations: null,
    technicalChecks: null,
  };
}
