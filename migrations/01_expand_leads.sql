-- MIGRATION 01
-- Expande a tabela leads com campos de qualificacao, scoring, agendamento e remarketing.
-- Nota: PostgreSQL nao permite coluna GENERATED STORED com NOW()/CURRENT_DATE
-- porque a expressao precisa ser imutavel. Por isso dias_no_funil e materializada.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS empresa VARCHAR(255),
  ADD COLUMN IF NOT EXISTS cargo VARCHAR(100),
  ADD COLUMN IF NOT EXISTS segmento VARCHAR(50),
  ADD COLUMN IF NOT EXISTS origem_lead VARCHAR(50),
  ADD COLUMN IF NOT EXISTS etapa_funil VARCHAR(50) DEFAULT 'novo',
  ADD COLUMN IF NOT EXISTS interesse_principal VARCHAR(50),
  ADD COLUMN IF NOT EXISTS tempo_problema VARCHAR(50),
  ADD COLUMN IF NOT EXISTS tratamento_anterior BOOLEAN,
  ADD COLUMN IF NOT EXISTS urgencia VARCHAR(20),
  ADD COLUMN IF NOT EXISTS abertura_investimento VARCHAR(20),
  ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS temperatura VARCHAR(20) DEFAULT 'cold',
  ADD COLUMN IF NOT EXISTS nivel_qualificacao VARCHAR(30) DEFAULT 'novo',
  ADD COLUMN IF NOT EXISTS objecao_atual VARCHAR(50),
  ADD COLUMN IF NOT EXISTS objecao_tentativas INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proposta_enviada_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS proposta_valor DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS proposta_aceita_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS proposta_recusada_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS motivo_recusa VARCHAR(255),
  ADD COLUMN IF NOT EXISTS total_agendado INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_comparecido INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agendamento_uuid VARCHAR(36),
  ADD COLUMN IF NOT EXISTS follow_up_sequencia VARCHAR(50),
  ADD COLUMN IF NOT EXISTS follow_up_step INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS follow_up_total INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS follow_up_iniciado_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS segmento_remarketing VARCHAR(50),
  ADD COLUMN IF NOT EXISTS tentativas_remarketing INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS convertido_via_remarketing BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_conversao TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dias_no_funil INTEGER DEFAULT 0;

UPDATE leads
   SET etapa_funil = CASE
         WHEN etapa_funil IS NULL OR etapa_funil = 'novo'
           THEN COALESCE(NULLIF(data->>'etapa_funil', ''), etapa_funil, 'novo')
         ELSE etapa_funil
       END,
       interesse_principal = COALESCE(
         interesse_principal,
         NULLIF(data->>'interesse_principal', ''),
         NULLIF(data->'qualificacao'->>'interesse_principal', '')
       ),
       tempo_problema = COALESCE(
         tempo_problema,
         NULLIF(data->>'tempo_problema', ''),
         NULLIF(data->'qualificacao'->>'tempo_problema', '')
       ),
       tratamento_anterior = COALESCE(
         tratamento_anterior,
         CASE
           WHEN data ? 'tratamento_anterior' THEN NULLIF(data->>'tratamento_anterior', '')::boolean
           WHEN data->'qualificacao' ? 'tratamento_anterior' THEN NULLIF(data->'qualificacao'->>'tratamento_anterior', '')::boolean
           ELSE NULL
         END
       ),
       urgencia = COALESCE(
         urgencia,
         NULLIF(data->>'urgencia_percebida', ''),
         NULLIF(data->'qualificacao'->>'urgencia', '')
       ),
       abertura_investimento = COALESCE(
         abertura_investimento,
         NULLIF(data->'qualificacao'->>'abertura_investimento', '')
       ),
       lead_score = CASE
         WHEN lead_score = 0 THEN COALESCE(score, NULLIF(data->>'score', '')::integer, 0)
         ELSE lead_score
       END,
       temperatura = CASE
         WHEN temperatura IS NULL OR temperatura = 'cold' THEN
           CASE
             WHEN COALESCE(score, NULLIF(data->>'score', '')::integer, 0) >= 70 THEN 'hot'
             WHEN COALESCE(score, NULLIF(data->>'score', '')::integer, 0) >= 45 THEN 'warm'
             ELSE 'cold'
           END
         ELSE temperatura
       END,
       nivel_qualificacao = CASE
         WHEN nivel_qualificacao IS NULL OR nivel_qualificacao = 'novo'
           THEN COALESCE(NULLIF(data->'qualificacao'->>'nivel_qualificacao', ''), nivel_qualificacao, 'novo')
         ELSE nivel_qualificacao
       END,
       objecao_atual = COALESCE(
         objecao_atual,
         NULLIF(data->'qualificacao'->>'objecao_atual', '')
       ),
       agendamento_uuid = COALESCE(
         agendamento_uuid,
         NULLIF(data->>'agendamento_uuid', '')
       ),
       follow_up_sequencia = COALESCE(
         follow_up_sequencia,
         NULLIF(data->>'follow_up_sequencia', '')
       ),
       follow_up_step = CASE
         WHEN follow_up_step = 0 THEN COALESCE(NULLIF(data->>'follow_up_step', '')::integer, 0)
         ELSE follow_up_step
       END,
       follow_up_total = CASE
         WHEN follow_up_total = 0 THEN COALESCE(follow_up_count_new, NULLIF(data->>'follow_up_count', '')::integer, 0)
         ELSE follow_up_total
       END,
       follow_up_iniciado_em = COALESCE(
         follow_up_iniciado_em,
         NULLIF(data->>'follow_up_iniciado_em', '')::timestamp
       ),
       segmento_remarketing = COALESCE(
         segmento_remarketing,
         NULLIF(data->>'segmento_remarketing', '')
       ),
       tentativas_remarketing = CASE
         WHEN tentativas_remarketing = 0 THEN COALESCE(NULLIF(data->>'tentativas_remarketing', '')::integer, 0)
         ELSE tentativas_remarketing
       END,
       convertido_via_remarketing = CASE
         WHEN convertido_via_remarketing = FALSE THEN COALESCE(NULLIF(data->>'convertido_via_remarketing', '')::boolean, FALSE)
         ELSE convertido_via_remarketing
       END,
       dias_no_funil = GREATEST(CURRENT_DATE - COALESCE(primeiro_contato::date, CURRENT_DATE), 0);

COMMENT ON COLUMN leads.dias_no_funil IS 'Snapshot materializado; atualizar por rotina ou query de reporting.';