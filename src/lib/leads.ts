// Guardado de leads en Cloudflare D1.
export interface LeadRecord {
  email: string;
  url: string;
  domain: string;
  finalScore: number;
  aiAvailable: boolean;
  ip: string;
  userAgent: string;
}

export async function saveLead(db: D1Database, lead: LeadRecord): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO leads (email, url, domain, final_score, ai_available, ip, user_agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(
        lead.email,
        lead.url,
        lead.domain,
        lead.finalScore,
        lead.aiAvailable ? 1 : 0,
        lead.ip,
        lead.userAgent
      )
      .run();
  } catch (err) {
    // Capturar el lead importa, pero no debe tumbar el escaneo si D1 falla.
    console.error('saveLead failed:', err);
  }
}
