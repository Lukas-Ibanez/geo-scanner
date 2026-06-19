/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Variables y bindings disponibles en `Astro.locals.runtime.env` dentro del Worker.
// Binding mínimo de Workers AI (evita depender del tipo `Ai` de versiones nuevas
// de @cloudflare/workers-types, que la versión instalada podría no exportar).
interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface Env {
  // Bindings de Cloudflare (declarados en wrangler.toml)
  SCAN_CACHE: KVNamespace;
  DB: D1Database;
  AI?: WorkersAiBinding; // Workers AI (opcional: si falta, ese proveedor degrada)

  // Secrets (inyectados por .dev.vars en local / wrangler secret en prod)
  GEMINI_API_KEY: string;
  ANTHROPIC_API_KEY: string; // solo necesario si AI_PROVIDER=claude
  RESEND_API_KEY?: string; // si falta, el envío del informe se omite silenciosamente

  // Opcionales (con defaults en el código)
  GEMINI_MODEL?: string;
  GEMINI_DAILY_LIMIT?: string;
  ANTHROPIC_MODEL?: string; // override del modelo de Claude (default 'claude-haiku-4-5')
  ANTHROPIC_DAILY_LIMIT?: string; // tope diario de llamadas a Claude (default 200, 0 = sin tope)
  DETAILED_MODEL?: string; // modelo del informe detallado (default 'claude-haiku-4-5')
  DETAILED_PASSPHRASE?: string; // passphrase que desbloquea el informe 'detailed' (de pago)
  RATE_LIMIT_PER_HOUR?: string;
  RATE_LIMIT_WHITELIST?: string;
  CACHE_TTL_HOURS?: string;
  PORTFOLIO_CTA_URL?: string;
  AI_PROVIDER?: string; // 'hybrid' (default) | 'gemini' | 'claude' | 'workers-ai'
  WORKERSAI_MODEL?: string; // override del modelo de Workers AI
  RESEND_FROM?: string; // remitente verificado en Resend, p.ej. "GEO Scanner <informe@geo.lukasibanez.dev>"
  RESEND_REPLY_TO?: string; // correo de respuesta opcional
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
