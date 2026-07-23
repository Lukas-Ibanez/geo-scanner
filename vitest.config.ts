// vitest config — tests para los módulos puros del proyecto.
// Por ahora solo testeamos los que no requieren bindings de Cloudflare:
// validate.ts, contentShared.ts, y cache.ts (con un mock de KV).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Los tests son rápidos: timeout bajo para iterar.
    testTimeout: 5000,
  },
  resolve: {
    // Necesario para resolver los tipos de @cloudflare/workers-types.
    alias: {
      '~': new URL('./src/', import.meta.url).pathname,
    },
  },
});
