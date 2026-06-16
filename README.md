# GEO Scanner

Herramienta web gratuita que escanea cualquier sitio y evalúa qué tan preparado está para
aparecer en **motores de búsqueda generativos** (ChatGPT, Perplexity, Google AI Overviews,
Gemini, Claude). Pensada para dueños de negocio **no técnicos**: entrega un puntaje simple
(0–100) y recomendaciones en lenguaje humano. Funciona como **lead magnet** (captura el
correo a cambio del análisis).

Se despliega en **`geo.lukasibanez.dev`**.

---

## Cómo funciona

1. El usuario pega la URL de su sitio (y su correo) y pulsa **Escanear**.
2. El endpoint `POST /api/scan`:
   - valida la URL, aplica **rate limit por IP** y revisa la **caché** (KV);
   - descarga el HTML + `robots.txt` / `llms.txt` / `sitemap.xml` en paralelo;
   - extrae señales con **HTMLRewriter** (nativo de Workers);
   - calcula un **puntaje técnico** determinista;
   - pide a **Gemini Flash** (REST + structured output) un análisis de contenido;
   - combina ambos (**40% técnico + 60% contenido**) en un puntaje final;
   - guarda el **lead** en D1 y cachea el resultado.
3. La landing muestra el puntaje, un veredicto y 3–5 recomendaciones accionables.

### Resultado en dos capas (para monetizar a futuro)

El resultado se entrega partido y el **gating vive en el servidor**:

- **teaser** (siempre): puntaje, veredicto, subscores y _cuántas_ mejoras se detectaron.
- **full** (gated): las recomendaciones y el detalle técnico.

El acceso al `full` lo decide [`src/lib/entitlement.ts`](src/lib/entitlement.ts) → hoy basta
con un **correo válido**. Para **cobrar por uso** en el futuro, se cambia solo esa función.
La UI soporta dos flujos vía la constante `REVEAL_FLOW` en [`src/pages/index.astro`](src/pages/index.astro):

- `one-step`: pide el correo junto a la URL (default).
- `two-step`: muestra el puntaje gratis y pide el correo para revelar las recomendaciones.

---

## Stack

- **Astro** (`output: 'server'`) + adaptador **@astrojs/cloudflare**
- **Cloudflare Pages/Workers** (plan gratuito)
- **HTMLRewriter** para parsear HTML (sin cheerio ni Node APIs)
- **Gemini Flash** vía API REST (sin SDK de Node)
- **Cloudflare KV** (caché + rate limit) y **D1** (leads)
- UI: una _island_ en **vanilla JS** (cero dependencias de framework en el cliente)

---

## Estructura

```
src/
  pages/
    index.astro          Landing estática (prerender)
    api/scan.ts          POST /api/scan — orquesta el flujo
  components/            ScanForm.astro
  layouts/Base.astro
  scripts/scanner-island.ts   Lógica de cliente (vanilla JS)
  styles/global.css
  lib/                   Lógica del escaneo (ver más abajo)
schema.sql               Tabla `leads` (D1)
wrangler.toml            Bindings KV + D1
```

`src/lib/`: `validate` · `fetchSite` · `parseHtml` (HTMLRewriter) · `technicalScore` ·
`gemini` · `score` · `entitlement` · `cache` · `rateLimit` · `leads` · `types`.

---

## Requisitos

- **Node.js 20+** (este repo se probó con Node 24 LTS).
- Una cuenta de **Cloudflare** (gratuita) para KV, D1 y el deploy.
- Una **API key de Google AI Studio** (gratuita): https://aistudio.google.com/app/apikey

---

## Setup local

```bash
# 1) Instalar dependencias
npm install

# 2) Configurar el secret de Gemini
cp .dev.vars.example .dev.vars      # y edita GEMINI_API_KEY=...

# 3) Crear la tabla de leads en la D1 LOCAL
npm run db:local

# 4) Compilar y levantar el runtime real (workerd, con KV y D1 locales)
npm run build
npm run preview                     # wrangler pages dev ./dist  → http://127.0.0.1:8788
```

> ⚠️ **Importante:** `HTMLRewriter` solo existe en el runtime de Workers (**workerd**), **no
> en `astro dev`** (que corre en Node). Por eso el endpoint se prueba con
> `npm run preview` (wrangler) sobre el build, **no** con `astro dev`. `astro dev` sirve para
> iterar la UI, pero un escaneo real fallaría ahí.

Probar el endpoint:

```bash
curl -X POST http://127.0.0.1:8788/api/scan \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com","email":"test@test.com"}'
```

(Sin `GEMINI_API_KEY` el escaneo igual responde, en **modo degradado**: solo puntaje técnico.)

---

## Variables de entorno y bindings

| Nombre | Tipo | Default | Descripción |
|---|---|---|---|
| `GEMINI_API_KEY` | secret | — | Clave de Google AI Studio (requerida para el análisis con IA). |
| `GEMINI_MODEL` | var | `gemini-2.5-flash` | Modelo de Gemini a usar. |
| `GEMINI_DAILY_LIMIT` | var | `200` | Tope global de llamadas a Gemini por día (0 = sin tope). Protege tu cuota gratuita. |
| `RATE_LIMIT_PER_HOUR` | var | `5` | Escaneos por IP por hora. |
| `RATE_LIMIT_WHITELIST` | var | — | IPs sin límite, separadas por coma (p.ej. la tuya para probar). |
| `CACHE_TTL_HOURS` | var | `6` | Horas de validez de la caché por dominio. |
| `SCAN_CACHE` | KV binding | — | Caché de resultados + contadores de rate limit. |
| `DB` | D1 binding | — | Base de datos de leads. |

- **Local:** `GEMINI_API_KEY` va en `.dev.vars`. Los bindings KV/D1 los simula wrangler.
- **Producción:** el secret se pone con `wrangler pages secret put GEMINI_API_KEY`; los
  bindings y las vars opcionales se declaran en `wrangler.toml` (o en el panel de Pages).

---

## Crear los recursos en Cloudflare

```bash
# Autenticarse
npx wrangler login

# KV (caché). Copia el id (y el preview_id) al bloque [[kv_namespaces]] de wrangler.toml
npx wrangler kv namespace create SCAN_CACHE
npx wrangler kv namespace create SCAN_CACHE --preview

# D1 (leads). Copia el database_id al bloque [[d1_databases]] de wrangler.toml
npx wrangler d1 create geo_leads

# Aplicar el esquema a la D1 REMOTA
npm run db:remote
```

Luego edita [`wrangler.toml`](wrangler.toml) y reemplaza los `REEMPLAZAR_CON_*` por los ids reales.

---

## Deploy a Cloudflare Pages

```bash
# Secret de Gemini en producción
npx wrangler pages secret put GEMINI_API_KEY

# Build + deploy (lee los bindings de wrangler.toml)
npm run deploy
```

En la **primera** ejecución, wrangler crea el proyecto de Pages. Después:

1. En el panel de Cloudflare → **Pages → tu proyecto → Custom domains**, agrega
   `geo.lukasibanez.dev` (Cloudflare crea el registro CNAME).
2. Verifica en **Settings → Functions → Bindings** que `SCAN_CACHE` (KV) y `DB` (D1) estén
   asignados al entorno de producción.

---

## Notas de runtime (plan gratuito)

- **CPU:** 10 ms por invocación, pero **el tiempo esperando red no cuenta** (fetch del sitio
  + espera de Gemini). El parseo es streaming y liviano; el HTML se trunca (~3.000 palabras).
- **Subrequests:** usamos ~5 por escaneo (sitio + 3 auxiliares + Gemini); el límite es 50.
- **KV (free):** ~1.000 writes/día. La caché (6 h) y el rate-limit caben de sobra a la
  escala de un lead magnet. Para un limitador estricto se necesitarían Durable Objects (de pago).
- **Sessions:** el adaptador de Astro 5 auto-activa _sessions_ sobre un binding KV llamado
  `SESSION`. Este proyecto **no usa `Astro.session`**, así que no hace falta. Si en el futuro
  lo usas, agrega un `[[kv_namespaces]]` con `binding = "SESSION"`.

---

## Ajustes rápidos

- **Puntaje técnico:** pesos y umbrales en [`src/lib/technicalScore.ts`](src/lib/technicalScore.ts).
- **Mezcla técnico/contenido (40/60):** [`src/lib/score.ts`](src/lib/score.ts).
- **Prompt y modelo de Gemini:** [`src/lib/gemini.ts`](src/lib/gemini.ts).
- **Flujo de captura (one-step / two-step):** `REVEAL_FLOW` en [`src/pages/index.astro`](src/pages/index.astro).
- **Lógica de acceso (gating / cobro futuro):** [`src/lib/entitlement.ts`](src/lib/entitlement.ts).
- **CTA final (link a servicios):** `CTA_URL` en [`src/scripts/scanner-island.ts`](src/scripts/scanner-island.ts).

---

## Scripts

| Script | Acción |
|---|---|
| `npm run dev` | `astro dev` (UI; el escaneo real NO funciona aquí, ver nota de runtime). |
| `npm run build` | Compila a `dist/` (worker de Cloudflare). |
| `npm run preview` | `wrangler pages dev ./dist` — runtime workerd con KV/D1 locales. |
| `npm run deploy` | Build + `wrangler pages deploy ./dist`. |
| `npm run db:local` | Aplica `schema.sql` a la D1 local. |
| `npm run db:remote` | Aplica `schema.sql` a la D1 remota. |
| `npm run check` | `astro check` (chequeo de tipos). |
