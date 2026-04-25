-- MIGRATION 05
-- Rastreia propostas e planos enviados para cada lead.

CREATE TABLE IF NOT EXISTS propostas (
  id SERIAL PRIMARY KEY,
  lead_id VARCHAR(20) NOT NULL,
  titulo VARCHAR(255) NOT NULL,
  descricao TEXT,
  valor_mensal DECIMAL(10,2),
  valor_total DECIMAL(10,2),
  plano_nome VARCHAR(100),
  status VARCHAR(50) DEFAULT 'enviada',
  enviada_em TIMESTAMP DEFAULT NOW(),
  visualizada_em TIMESTAMP,
  respondida_em TIMESTAMP,
  expira_em TIMESTAMP,
  motivo_recusa VARCHAR(255),
  pode_fazer_upsell BOOLEAN DEFAULT FALSE,
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_propostas_lead_id ON propostas(lead_id);
CREATE INDEX IF NOT EXISTS idx_propostas_status ON propostas(status);