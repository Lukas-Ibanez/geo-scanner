-- GEO Scanner — esquema de la base de leads (Cloudflare D1 / SQLite)
-- Aplicar local:  npm run db:local
-- Aplicar remoto: npm run db:remote

CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  domain       TEXT    NOT NULL,
  final_score  INTEGER,
  ai_available INTEGER NOT NULL DEFAULT 1,   -- 1 = análisis con IA disponible, 0 = degradado
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_domain  ON leads(domain);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
