// leadSystem/leadState.js
// Definição clara do estado do Lead (resolve o problema de "esquece o lead")

const LeadState = {
  createNew: (phone, name = "Cliente") => ({
    lead_id: phone,
    nome: name,
    telefone: phone,
    email: null,
    etapa_funil: "novo",                    // novo → em_qualificacao → qualificado → hot → follow_up
    score: 0,
    lead_score: 0,
    temperatura: 'cold',
    nivel_qualificacao: 'novo',
    interesses: [],
    valor_potencial: null,
    ultima_interacao: new Date().toISOString(),
    total_mensagens_usuario: 0,
    total_mensagens_assistente: 0,
    follow_up_count: 0,
    follow_up_proximo: null,
    follow_up_sequencia: null,
    follow_up_step: 0,
    follow_up_iniciado_em: null,
    follow_up_ultimo_envio_em: null,
    follow_up_cancelado_em: null,
    follow_up_encerrado_em: null,
    follow_up_ativo: false,
    follow_up_ultimo_motivo: null,
    motivo_recusa: null,
    segmento_remarketing: null,
    tentativas_remarketing: 0,
    convertido_via_remarketing: false,
    data_conversao: null,
    remarketing_proximo: null,
    remarketing_base_em: null,
    remarketing_ultimo_envio_em: null,
    proximo_follow_up: null,                // ISO string ou null
    contexto_conversa: [],                  // histórico resumido
    qualificacao: {
      interesse_principal: null,
      tempo_problema: null,
      tratamento_anterior: null,
      descricao_tratamento: null,
      urgencia: null,
      decide_sozinho: null,
      abertura_investimento: null,
      objecao_atual: null,
      sentimento: null,
      pronto_para_agendamento: false,
      nivel_qualificacao: 'novo',
      sinais_extraidos_em: null,
    },
    // Campos legados mantidos por compatibilidade com o fluxo conversacional já implantado.
    interesse_principal: null,
    tempo_problema: null,
    tratamento_anterior: null,
    descricao_tratamento_anterior: null,
    sintoma_adicional: null,
    urgencia_percebida: 'media',
    score_breakdown: null,
    score_recomendacao: null,
    score_recalculado_em: null,
    tags: [],
    ultimo_mensagem: null
  })
};

module.exports = LeadState;