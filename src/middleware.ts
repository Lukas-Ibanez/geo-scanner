// Middleware global de Astro/Cloudflare — agrega headers de seguridad a
// TODAS las respuestas (SSR y estáticas por igual).
//
// Configuración intencionalmente laxa: páginas que cargan scripts inline
// (el escáner usa JSON.parse / DOM directo, no scripts embebidos, así que
// 'unsafe-inline' no es necesario en script-src).
//
// CSP nota: el widget de Turnstile se carga desde challenges.cloudflare.com.
// frame-src debe permitirlo para que el iframe renderice. connect-src
// permite las llamadas a /api/* (mismo origen) y a challenges.cloudflare.com
// para el siteverify.
import { defineMiddleware } from 'astro:middleware';

const SECURITY_HEADERS: Record<string, string> = {
  // Clickjacking: nadie puede embeber tu sitio en un iframe.
  'X-Frame-Options': 'DENY',
  // Anti MIME-sniffing: el browser respeta el Content-Type declarado.
  'X-Content-Type-Options': 'nosniff',
  // Referrer reducido: solo mandamos el origen (no la URL completa) a terceros.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Permisos denegados por defecto: nada de geolocalización, cámara, etc.
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  // HSTS (1 año, con preload opcional). Como estás en HTTPS ya, no rompe nada.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // CSP: default-src 'self' es lo más restrictivo. Ajustar si algún script
  // de terceros falla (ej. agregar su origen a script-src).
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self' https://challenges.cloudflare.com",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'", // el CSS inline de emails + astro usa <style>
    "font-src 'self' data:",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    // No sobreescribimos si el endpoint ya setea algo (ej. Cache-Control).
    if (!response.headers.has(key)) {
      response.headers.set(key, value);
    }
  }
  return response;
});
