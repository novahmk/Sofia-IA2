/**
 * AGENTE COMERCIAL — Vendas, objeções e conversão
 * ══════════════════════════════════════════════════════════
 * - Verifica playbooks de respostas que já funcionaram
 * - Injeta contexto especializado em vendas no getSofiaResponse
 * - Cobre: objeção de preço, tempo, confiança, hesitação
 */

'use strict';

const playbookStorage = require('../improvement/playbookStorage');

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
    console.log(`💰 [AgentComercial] tipo: ${intention.type}`);

    // 1. Consulta playbook: resposta que já funcionou para padrão similar
    const playbook = playbookStorage.findSimilar(userMessage, intention.type);
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

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      `Follow-ups: ${lead.follow_up_count || 0}`,
      historico ? `\nHistórico:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
      objCtx,
    ]
      .filter(Boolean)
      .join('\n');

    const getSofiaResponse = require('../ai').getSofiaResponse;
    return getSofiaResponse(phone, userMessage, leadContext);
  }
}

module.exports = new AgentCommercial();
