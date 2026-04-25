-- MIGRATION 06
-- Registra campanhas e disparos de remarketing.

CREATE TABLE IF NOT EXISTS remarketing_campaigns (
  id SERIAL PRIMARY KEY,
  lead_id VARCHAR(20) NOT NULL,
  segmento VARCHAR(50) NOT NULL,
  titulo VARCHAR(255),
  mensagem TEXT NOT NULL,
  oferta_especial VARCHAR(255),
  canal VARCHAR(20) DEFAULT 'whatsapp',
  enviado_em TIMESTAMP DEFAULT NOW(),
  visualizado_em TIMESTAMP,
  respondido_em TIMESTAMP,
  convertido_em TIMESTAMP,
  status VARCHAR(50) DEFAULT 'enviado',
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remarketing_lead_id ON remarketing_campaigns(lead_id);
CREATE INDEX IF NOT EXISTS idx_remarketing_segmento ON remarketing_campaigns(segmento);
CREATE INDEX IF NOT EXISTS idx_remarketing_status ON remarketing_campaigns(status);