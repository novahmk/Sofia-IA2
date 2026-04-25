-- MIGRATION 02
-- Cria a tabela de agendamentos robustos com rastreabilidade de lembretes e presenca.

CREATE TABLE IF NOT EXISTS agendamentos_robusto (
  uuid VARCHAR(36) PRIMARY KEY,
  lead_id VARCHAR(20) NOT NULL,
  data_agendamento TIMESTAMP NOT NULL,
  duracao_minutos INTEGER DEFAULT 30,
  status_confirmacao VARCHAR(50) DEFAULT 'pendente_confirmacao',
  cliente_confirmou_em TIMESTAMP,
  cliente_cancelou_em TIMESTAMP,
  motivo_cancelamento TEXT,
  link_reuniao VARCHAR(500),
  plataforma_reuniao VARCHAR(50),
  cliente_entrou_em TIMESTAMP,
  cliente_nao_apareceu BOOLEAN DEFAULT FALSE,
  duracao_real_minutos INTEGER,
  lembrete_24h_enviado BOOLEAN DEFAULT FALSE,
  lembrete_24h_enviado_em TIMESTAMP,
  lembrete_2h_enviado BOOLEAN DEFAULT FALSE,
  lembrete_2h_enviado_em TIMESTAMP,
  feedback_pos_reuniao TEXT,
  converteu_apos_reuniao BOOLEAN,
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_agendamentos_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'trg_agendamentos_updated'
       AND tgrelid = 'agendamentos_robusto'::regclass
  ) THEN
    CREATE TRIGGER trg_agendamentos_updated
    BEFORE UPDATE ON agendamentos_robusto
    FOR EACH ROW EXECUTE FUNCTION update_agendamentos_timestamp();
  END IF;
END;
$$;