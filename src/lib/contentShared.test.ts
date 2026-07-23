import { describe, it, expect } from 'vitest';
import { degraded, finalizeResult, clampInt } from './contentShared';

describe('clampInt', () => {
  it('clampa a [0, 100]', () => {
    expect(clampInt(50)).toBe(50);
    expect(clampInt(0)).toBe(0);
    expect(clampInt(100)).toBe(100);
    expect(clampInt(-5)).toBe(0);
    expect(clampInt(150)).toBe(100);
  });
  it('parsea strings numéricos', () => {
    expect(clampInt('75')).toBe(75);
    expect(clampInt('0')).toBe(0);
    expect(clampInt('-10')).toBe(0);
    expect(clampInt('200')).toBe(100);
  });
  it('devuelve 0 para valores no numéricos', () => {
    expect(clampInt(null)).toBe(0);
    expect(clampInt(undefined)).toBe(0);
    expect(clampInt('abc')).toBe(0);
    expect(clampInt(NaN)).toBe(0);
  });
  it('redondea', () => {
    expect(clampInt(50.4)).toBe(50);
    expect(clampInt(50.6)).toBe(51);
  });
});

describe('degraded', () => {
  it('devuelve available=false con el reason en debug', () => {
    const r = degraded('rate-limit');
    expect(r.available).toBe(false);
    expect(r.debug).toBe('rate-limit');
    expect(r.claridadNegocio).toBe(0);
    expect(r.citabilidad).toBe(0);
    expect(r.autoridad).toBe(0);
    expect(r.claridadGeografica).toBe(0);
  });

  it('incluye las recomendaciones fallback', () => {
    const r = degraded('cualquier cosa');
    expect(r.recomendaciones.length).toBeGreaterThan(0);
    // Las 4 fallback recs son de negocio, no técnicas.
    for (const rec of r.recomendaciones) {
      expect(rec.toLowerCase()).not.toMatch(/json-ld|schema|meta description|etiqueta|canonical/);
    }
  });
});

describe('finalizeResult', () => {
  it('extrae scores y recomendaciones de un payload válido', () => {
    const r = finalizeResult({
      claridadNegocio: 75,
      citabilidad: 80,
      autoridad: 65,
      claridadGeografica: 90,
      recomendaciones: ['Rec 1', 'Rec 2', 'Rec 3', 'Rec 4', 'Rec 5'],
    });
    expect(r.available).toBe(true);
    expect(r.claridadNegocio).toBe(75);
    expect(r.recomendaciones).toHaveLength(5);
  });

  it('clampa scores fuera de rango', () => {
    const r = finalizeResult({
      claridadNegocio: 150,
      citabilidad: -10,
      autoridad: 50,
      claridadGeografica: 80,
      recomendaciones: ['a', 'b', 'c'],
    });
    expect(r.claridadNegocio).toBe(100);
    expect(r.citabilidad).toBe(0);
    expect(r.autoridad).toBe(50);
  });

  it('rellena con fallback si hay menos de 3 recomendaciones', () => {
    const r = finalizeResult({
      claridadNegocio: 50,
      citabilidad: 50,
      autoridad: 50,
      claridadGeografica: 50,
      recomendaciones: ['Solo una'],
    });
    expect(r.recomendaciones.length).toBeGreaterThanOrEqual(3);
  });

  it('corta a 5 recomendaciones máximo', () => {
    const r = finalizeResult({
      claridadNegocio: 50,
      citabilidad: 50,
      autoridad: 50,
      claridadGeografica: 50,
      recomendaciones: ['1', '2', '3', '4', '5', '6', '7'],
    });
    expect(r.recomendaciones).toHaveLength(5);
  });

  it('filtra recomendaciones vacías o no-string', () => {
    const r = finalizeResult({
      claridadNegocio: 50,
      citabilidad: 50,
      autoridad: 50,
      claridadGeografica: 50,
      recomendaciones: ['OK', '', '   ', 42, null, 'También OK', 'Otra', 'Y otra'] as unknown[],
    });
    // Solo sobreviven los strings no-vacíos, en orden.
    expect(r.recomendaciones[0]).toBe('OK');
    expect(r.recomendaciones[1]).toBe('También OK');
    expect(r.recomendaciones[2]).toBe('Otra');
    // Los 42, null, '', '   ' fueron filtrados.
    expect(r.recomendaciones.length).toBeLessThanOrEqual(5);
  });

  it('maneja payload vacío o null', () => {
    const r1 = finalizeResult(null);
    expect(r1.available).toBe(true);
    expect(r1.claridadNegocio).toBe(0);
    expect(r1.recomendaciones.length).toBeGreaterThan(0);
    const r2 = finalizeResult({});
    expect(r2.available).toBe(true);
  });
});
