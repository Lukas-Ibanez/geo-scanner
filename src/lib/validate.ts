// Validación y normalización de la URL y el email recibidos.

export interface ValidatedInput {
  url: string; // URL completa normalizada (sin hash)
  origin: string; // esquema + host (para robots.txt / llms.txt / sitemap.xml)
  domain: string; // hostname (clave de caché)
  email: string | null;
}

export type ValidationResult =
  | { ok: true; data: ValidatedInput }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hosts privados / loopback que no tiene sentido (ni es seguro) escanear.
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|0\.)/;

export function validateAndNormalize(rawUrl: unknown, rawEmail: unknown): ValidationResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, error: 'Falta la dirección del sitio.' };
  }

  let input = rawUrl.trim();
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'La dirección del sitio no es válida.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Solo se pueden escanear direcciones http o https.' };
  }

  const host = parsed.hostname.toLowerCase();
  // Un host público siempre tiene un punto; esto bloquea localhost, nombres de
  // intranet y literales IPv6 ([::1]). Más los rangos privados/loopback IPv4.
  if (!host.includes('.') || PRIVATE_HOST_RE.test(host)) {
    return { ok: false, error: 'Esa dirección no se puede escanear.' };
  }

  let email: string | null = null;
  if (typeof rawEmail === 'string' && rawEmail.trim() !== '') {
    const e = rawEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 254) {
      return { ok: false, error: 'El correo no parece válido.' };
    }
    email = e;
  }

  parsed.hash = '';
  return {
    ok: true,
    data: {
      url: parsed.toString(),
      origin: parsed.origin,
      domain: host,
      email,
    },
  };
}
