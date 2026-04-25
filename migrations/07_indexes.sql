-- MIGRATION 07
-- Indices de performance para consultas frequentes do funil.

CREATE INDEX IF NOT EXISTS idx_leads_follow_up_proximo ON leads(follow_up_proximo)
  WHERE follow_up_proximo IS NOT NULL
    AND COALESCE(etapa_funil, 'novo') NOT IN ('fechado', 'inativo');

CREATE INDEX IF NOT EXISTS idx_leads_temperatura ON leads(temperatura);
CREATE INDEX IF NOT EXISTS idx_leads_etapa_funil ON leads(etapa_funil);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score DESC);

CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos_robusto(data_agendamento)
  WHERE status_confirmacao = 'confirmado';