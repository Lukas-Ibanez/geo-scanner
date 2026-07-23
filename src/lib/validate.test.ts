import { describe, it, expect } from 'vitest';
import { validateAndNormalize } from './validate';

describe('validateAndNormalize', () => {
  describe('URL validation', () => {
    it('acepta una URL https válida y la normaliza', () => {
      const r = validateAndNormalize('https://example.com', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.url).toBe('https://example.com/');
        expect(r.data.domain).toBe('example.com');
        expect(r.data.origin).toBe('https://example.com');
      }
    });

    it('prepende https si no hay esquema', () => {
      const r = validateAndNormalize('example.com', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.url).toBe('https://example.com/');
    });

    it('acepta http (no solo https)', () => {
      const r = validateAndNormalize('http://example.com', undefined);
      expect(r.ok).toBe(true);
    });

    it('rechaza protocolos no http/https', () => {
      // NOTA: ftp:// actualmente se "cuela" porque el código prepende https://
      // antes de chequear el protocolo. El test verifica que igual se rechaza
      // (aunque sea por el check de host sin punto). Cuando se arregle ese
      // edge case, este test queda igual.
      const r = validateAndNormalize('ftp://example.com', undefined);
      expect(r.ok).toBe(false);
    });

    it('rechaza URLs malformadas', () => {
      expect(validateAndNormalize('no es una url', undefined).ok).toBe(false);
      expect(validateAndNormalize('http://', undefined).ok).toBe(false);
    });

    it('rechaza string vacío', () => {
      expect(validateAndNormalize('', undefined).ok).toBe(false);
      expect(validateAndNormalize('   ', undefined).ok).toBe(false);
    });

    it('rechaza tipos no-string', () => {
      expect(validateAndNormalize(null, undefined).ok).toBe(false);
      expect(validateAndNormalize(undefined, undefined).ok).toBe(false);
      expect(validateAndNormalize(123, undefined).ok).toBe(false);
    });

    it('rechaza hosts privados / loopback (SSRF)', () => {
      const cases = [
        'http://127.0.0.1',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://172.16.0.1',
        'http://169.254.169.254', // AWS metadata service — el más peligroso
        'http://localhost',
      ];
      for (const c of cases) {
        const r = validateAndNormalize(c, undefined);
        expect(r.ok, `debería rechazar ${c}`).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/no se puede escanear/i);
      }
    });

    it('rechaza hosts sin punto (localhost implícito)', () => {
      expect(validateAndNormalize('http://intranet', undefined).ok).toBe(false);
    });

    it('lowercase del host', () => {
      const r = validateAndNormalize('https://EXAMPLE.COM/Path', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.domain).toBe('example.com');
    });

    it('remueve el fragmento de la URL', () => {
      const r = validateAndNormalize('https://example.com/page#section', undefined);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.url).not.toMatch(/#/);
    });

    it('trimea espacios al inicio/final', () => {
      const r = validateAndNormalize('  https://example.com  ', undefined);
      expect(r.ok).toBe(true);
    });
  });

  describe('email validation', () => {
    it('acepta un email válido en minúsculas', () => {
      const r = validateAndNormalize('https://example.com', 'User@Example.COM');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.email).toBe('user@example.com');
    });

    it('omite el email si es string vacío', () => {
      const r = validateAndNormalize('https://example.com', '');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.email).toBeNull();
    });

    it('omite el email si es solo whitespace', () => {
      const r = validateAndNormalize('https://example.com', '   ');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.email).toBeNull();
    });

    it('rechaza email sin @', () => {
      expect(validateAndNormalize('https://example.com', 'notanemail').ok).toBe(false);
    });

    it('rechaza email sin dominio', () => {
      expect(validateAndNormalize('https://example.com', 'user@').ok).toBe(false);
      expect(validateAndNormalize('https://example.com', 'user@domain').ok).toBe(false);
    });

    it('rechaza email sin TLD válido', () => {
      // TLD de 1 letra (no existe) y TLD con caracteres no-letra
      expect(validateAndNormalize('https://example.com', 'user@example.c').ok).toBe(false);
      expect(validateAndNormalize('https://example.com', 'user@example.123').ok).toBe(false);
    });

    it('acepta emails con TLDs comunes', () => {
      for (const e of ['user@example.com', 'a.b+c@sub.example.co.uk', 'user_name@x.io']) {
        expect(validateAndNormalize('https://example.com', e).ok, `debería aceptar ${e}`).toBe(true);
      }
    });

    it('rechaza email con puntos al inicio o final del local part', () => {
      expect(validateAndNormalize('https://example.com', '.user@example.com').ok).toBe(false);
      expect(validateAndNormalize('https://example.com', 'user.@example.com').ok).toBe(false);
    });

    it('rechaza email con puntos consecutivos', () => {
      expect(validateAndNormalize('https://example.com', 'us..er@example.com').ok).toBe(false);
    });

    it('rechaza email con espacios', () => {
      expect(validateAndNormalize('https://example.com', 'user @example.com').ok).toBe(false);
    });

    it('rechaza email > 254 chars (RFC 5321)', () => {
      const long = 'a'.repeat(250) + '@example.com';
      expect(validateAndNormalize('https://example.com', long).ok).toBe(false);
    });
  });
});
