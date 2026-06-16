// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // Render on-demand por defecto (necesario para /api/scan). La landing se marca
  // como `prerender = true` para servirse estática.
  output: 'server',
  adapter: cloudflare({
    // Expone los bindings de Cloudflare (KV, D1) durante `astro dev` vía miniflare.
    // OJO: HTMLRewriter NO existe en `astro dev` (Node); el endpoint se prueba con
    // `wrangler pages dev ./dist` sobre el build (runtime workerd).
    platformProxy: { enabled: true },
  }),
  site: 'https://geo.lukasibanez.dev',
});
