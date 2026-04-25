-- MIGRATION 04
-- Registra cada follow-up enviado e o resultado observado.

CREATE TABLE IF NOT EXISTS follow_up_history (
  id SERIAL PRIMARY KEY,
  lead_id VARCHAR(20) NOT NULL,
  sequencia_tipo VARCHAR(50) NOT NULL,
  step_numero INTEGER NOT NULL,
  mensagem TEXT NOT NULL,
  canal VARCHAR(20) DEFAULT 'whatsapp',
  enviado_em TIMESTAMP DEFAULT NOW(),
  visualizado_em TIMESTAMP,
  respondido_em TIMESTAMP,
  reativou_lead BOOLEAN DEFAULT FALSE,
  status VARCHAR(50) DEFAULT 'enviado'
);

CREATE INDEX IF NOT EXISTS idx_follow_up_history_lead_id ON follow_up_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_history_enviado_em ON follow_up_history(enviado_em);