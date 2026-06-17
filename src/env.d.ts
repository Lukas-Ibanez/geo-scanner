/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Variables y bindings disponibles en `Astro.locals.runtime.env` dentro del Worker.
interface Env {
  // Bindings de Cloudflare (declarados en wrangler.toml)
  SCAN_CACHE: KVNamespace;
  DB: D1Database;

  // Secrets (inyectados por .dev.vars en local / wrangler secret en prod)
  GEMINI_API_KEY: string;
  RESEND_API_KEY?: string; // si falta, el envío del informe se omite silenciosamente

  // Opcionales (con defaults en el código)
  GEMINI_MODEL?: string;
  GEMINI_DAILY_LIMIT?: string;
  RATE_LIMIT_PER_HOUR?: string;
  RATE_LIMIT_WHITELIST?: string;
  CACHE_TTL_HOURS?: string;
  PORTFOLIO_CTA_URL?: string;
  RESEND_FROM?: string; // remitente verificado en Resend, p.ej. "GEO Scanner <informe@geo.lukasibanez.dev>"
  RESEND_REPLY_TO?: string; // correo de respuesta opcional
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
