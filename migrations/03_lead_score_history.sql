-- MIGRATION 03
-- Registra a evolucao de score e temperatura de cada lead.

CREATE TABLE IF NOT EXISTS lead_score_history (
  id SERIAL PRIMARY KEY,
  lead_id VARCHAR(20) NOT NULL,
  score_anterior INTEGER DEFAULT 0,
  score_novo INTEGER NOT NULL,
  temperatura_nova VARCHAR(20),
  motivo VARCHAR(255),
  breakdown JSONB,
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_score_history_lead_id ON lead_score_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_score_history_criado_em ON lead_score_history(criado_em);