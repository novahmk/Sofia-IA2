/**
 * AGENTE COMERCIAL — Vendas, objeções e conversão
 * ══════════════════════════════════════════════════════════
 * - Verifica playbooks de respostas que já funcionaram
 * - Injeta contexto especializado em vendas no getSofiaResponse
 * - Cobre: objeção de preço, tempo, confiança, hesitação
 */

'use strict';

const playbookStorage = require('../improvement/playbookStorage');
const agendamentoRobusto = require('../leadSystem/agendamentoRobusto');

function readLeadField(lead, field) {
  if (!lead || typeof lead !== 'object') return null;
  if (field in lead) return lead[field];
  if (lead.qualificacao && typeof lead.qualificacao === 'object') {
    if (field in lead.qualificacao) return lead.qualificacao[field];
    if (field === 'descricao_tratamento_anterior' && 'descricao_tratamento' in lead.qualificacao) {
      return lead.qualificacao.descricao_tratamento;
    }
    if (field === 'urgencia_percebida' && 'urgencia' in lead.qualificacao) {
      return lead.qualificacao.urgencia;
    }
  }
  if (lead.data && typeof lead.data === 'object' && field in lead.data) return lead.data[field];
  return null;
}

function countAssistantQuestions(conversationHistory = []) {
  return (conversationHistory || [])
    .filter((message) => message.role === 'assistant')
    .reduce((count, message) => count + ((String(message.content || '').match(/\?/g) || []).length), 0);
}

/**
 * Identifica a fase conversacional atual do lead.
 * Fase 1: Intenção não capturada ainda.
 * Fase 2: Intenção capturada, aprofundando.
 * Fase 3: Pronto para próximo passo.
 */
function detectConversationPhase(lead = {}, conversationHistory = []) {
  const messages = conversationHistory || [];
  const userMessages = messages.filter((message) => message.role === 'user');

  if (userMessages.length === 0) return 'phase_1_intention';

  const hasIntention = Boolean(readLeadField(lead, 'interesse_principal'));
  const treatmentFlag = readLeadField(lead, 'tratamento_anterior');
  const hasContext = Boolean(
    readLeadField(lead, 'tempo_problema')
    || typeof treatmentFlag === 'boolean'
    || readLeadField(lead, 'sintoma_adicional')
  );

  if (!hasIntention) return 'phase_1_intention';
  if (!hasContext && countAssistantQuestions(messages) < 3) return 'phase_2_deepening';
  return 'phase_3_transition';
}

// Blocos de instrução por tipo de objeção
const OBJECTION_CONTEXTS = {
  price_objection: [
    '[AGENTE COMERCIAL — OBJEÇÃO DE PREÇO]',
    'Estratégia:',
    '1. Valide a preocupação (entendo que o investimento importa)',
    '2. Reframe: custo vs benefício de longo prazo',
    '3. Destaque a avaliação GRATUITA como próximo passo sem risco',
    '4. NÃO cite valores a menos que o cliente pergunte diretamente',
    '[FIM DA ESTRATÉGIA]',
  ].join('\n'),

  time_objection: [
    '[AGENTE COMERCIAL — OBJEÇÃO DE TEMPO/RESULTADO]',
    'Estratégia:',
    '1. Seja honesta: resultados variam por caso',
    '2. A avaliação gratuita determina o cronograma personalizado',
    '3. Reforce: agir cedo é mais fácil que remediar depois',
    '[FIM DA ESTRATÉGIA]',
  ].join('\n'),

  hesitation: [
    '[AGENTE COMERCIAL — HESITAÇÃO]',
    'Estratégia:',
    '1. Valide a dúvida — ela é normal e inteligente',
    '2. Ofereça próximo passo pequeno (avaliação gratuita, sem compromisso)',
    '3. Não force decisão agora. Plante a semente e encerre bem',
    '[FIM DA ESTRATÉGIA]',
  ].join('\n'),

  trust_objection: [
    '[AGENTE COMERCIAL — OBJEÇÃO DE CONFIANÇA]',
    'Estratégia:',
    '1. Mencione casos reais (genéricos, sem nome)',
    '2. Credenciais e localização (Vila Mariana, metrô Paraíso)',
    '3. Avaliação gratuita presencial remove a dúvida melhor que palavras',
    '[FIM DA ESTRATÉGIA]',
  ].join('\n'),
};

const PHASE_CONTEXTS = {
  phase_1_intention: [
    '[FLUXO CONVERSACIONAL — FASE 1]',
    'Objetivo: descobrir a intenção principal do lead com uma única pergunta aberta.',
    'Nunca mencione agendamento, preço, dados pessoais ou lista de serviços na primeira resposta.',
    'Modelo ideal: "Oi, tudo bem? 😊 Me conta: você está buscando ajuda para queda, crescimento, oleosidade, caspa ou outro incômodo no couro cabeludo?"',
    '[FIM DA FASE 1]',
  ].join('\n'),
  phase_2_deepening: [
    '[FLUXO CONVERSACIONAL — FASE 2]',
    'Objetivo: aprofundar com leveza e apenas UMA pergunta por mensagem.',
    'Pergunte somente o que falta descobrir: tempo do problema, tratamento anterior ou sintoma adicional.',
    'Mostre escuta antes da pergunta e não ultrapasse 3 perguntas de aprofundamento.',
    '[FIM DA FASE 2]',
  ].join('\n'),
  phase_3_transition: [
    '[FLUXO CONVERSACIONAL — FASE 3]',
    'Objetivo: transicionar com naturalidade para o próximo passo.',
    'Só ofereça agendamento quando houver intenção clara e algum contexto do caso.',
    'Se o lead ainda estiver inseguro, ofereça explicação antes de horários.',
    '[FIM DA FASE 3]',
  ].join('\n'),
};

class AgentCommercial {
  /**
   * Responde com foco em venda/conversão
   * @param {string} phone
   * @param {string} userMessage
   * @param {object} lead
   * @param {{ type: string, agent: string }} intention
   * @returns {Promise<string>}
   */
  async respond(phone, userMessage, lead, intention) {
    const conversationHistory = lead.contexto_conversa || [];
    const phase = detectConversationPhase(lead, conversationHistory);
    console.log(`💰 [AgentComercial] tipo: ${intention.type} | fase: ${phase}`);

    if (agendamentoRobusto.shouldStartFromQualification(lead, phase)) {
      const robustResult = await agendamentoRobusto.iniciarAgendamento(phone, lead.nome, lead);
      if (robustResult?.handled) {
        console.log('📅 [AgentComercial] Qualificação pronta → iniciando agendamento robusto');
        return robustResult.message;
      }
    }

    // 1. Consulta playbook: resposta que já funcionou para padrão similar
    const playbook = phase === 'phase_3_transition'
      ? playbookStorage.findSimilar(userMessage, intention.type)
      : null;
    if (playbook) {
      console.log(`📖 [AgentComercial] Playbook (taxa: ${(playbook.successRate * 100).toFixed(0)}%) → reutilizando`);
      return playbook.response;
    }

    // 2. Sem playbook → chamada GPT com contexto especializado
    const objCtx = OBJECTION_CONTEXTS[intention.type] || '';

    const historico = (lead.contexto_conversa || [])
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${m.content}`)
      .join('\n');

    const treatmentFlag = readLeadField(lead, 'tratamento_anterior');
    const phaseContext = PHASE_CONTEXTS[phase] || PHASE_CONTEXTS.phase_2_deepening;

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      `Lead score: ${lead.lead_score ?? lead.score ?? 0}`,
      `Temperatura: ${lead.temperatura || 'cold'}`,
      `Fase conversacional: ${phase}`,
      `Interesse principal: ${readLeadField(lead, 'interesse_principal') || 'não identificado'}`,
      `Tempo do problema: ${readLeadField(lead, 'tempo_problema') || 'não identificado'}`,
      `Tratamento anterior: ${typeof treatmentFlag === 'boolean' ? (treatmentFlag ? 'sim' : 'não') : 'não identificado'}`,
      `Sintoma adicional: ${readLeadField(lead, 'sintoma_adicional') || 'não identificado'}`,
      `Follow-ups: ${lead.follow_up_count || 0}`,
      lead.horasSemContato ? `Retomada após ${lead.horasSemContato}h sem contato` : '',
      historico ? `\nHistórico:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
      phaseContext,
      objCtx,
    ]
      .filter(Boolean)
      .join('\n');

    const getSofiaResponse = require('../ai').getSofiaResponse;
    return getSofiaResponse(phone, userMessage, leadContext);
  }
}

module.exports = Object.assign(new AgentCommercial(), { detectConversationPhase });
