// leadSystem/leadState.js
// Definicao clara do estado do Lead (resolve o problema de "esquece o lead")

const LeadState = {
  createNew: (phone, name = 'Cliente') => ({
    lead_id: phone,
    nome: name,
    telefone: phone,
    email: null,
    etapa_funil: 'novo',
    interesses: [],
    valor_potencial: null,
    ultima_interacao: new Date().toISOString(),
    follow_up_count: 0,
    proximo_follow_up: null,
    contexto_conversa: [],
    tags: [],
    ultimo_mensagem: null,
  }),
};

module.exports = LeadState;