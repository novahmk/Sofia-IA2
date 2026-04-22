/**
 * AGENTE TÉCNICO — Dúvidas sobre produtos e sintomas capilares
 * ══════════════════════════════════════════════════════════
 * - Especializado em perguntas sobre tratamentos, procedimentos e sintomas
 * - Injeta contexto técnico no getSofiaResponse para respostas mais precisas
 */

'use strict';

const TECHNICAL_CONTEXTS = {
  product_info: [
    '[AGENTE TÉCNICO — INFORMAÇÃO DE PRODUTO/PROCEDIMENTO]',
    'Modo operacional: especialista técnico',
    'Regras:',
    '1. Use os documentos da base de conhecimento disponíveis no [CONTEXTO RAG]',
    '2. Se a informação não estiver no RAG, diga "precisamos verificar"',
    '3. Explique de forma simples, sem jargão clínico excessivo',
    '4. Ao final de explicações técnicas, sugira avaliação gratuita para personalizar',
    '[FIM DO CONTEXTO TÉCNICO]',
  ].join('\n'),

  symptom_question: [
    '[AGENTE TÉCNICO — SINTOMA CAPILAR]',
    'Modo operacional: consultora especialista em saúde capilar',
    'Regras:',
    '1. Demonstre empatia pelo problema do cliente',
    '2. Indique que cada caso é único — não diagnostique remotamente',
    '3. Explique brevemente o que pode estar causando o sintoma descrito',
    '4. Conclua propondo avaliação gratuita para diagnóstico personalizado',
    '[FIM DO CONTEXTO TÉCNICO]',
  ].join('\n'),
};

class AgentTechnical {
  /**
   * Responde com foco técnico/educacional
   * @param {string} phone
   * @param {string} userMessage
   * @param {object} lead
   * @param {{ type: string }} intention
   * @returns {Promise<string>}
   */
  async respond(phone, userMessage, lead, intention) {
    console.log(`🔬 [AgentTecnico] tipo: ${intention.type}`);

    const techCtx = TECHNICAL_CONTEXTS[intention.type] || TECHNICAL_CONTEXTS.product_info;

    const historico = (lead.contexto_conversa || [])
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${m.content}`)
      .join('\n');

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      lead.horasSemContato ? `Retomada após ${lead.horasSemContato}h sem contato` : '',
      historico ? `\nHistórico:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
      techCtx,
    ]
      .filter(Boolean)
      .join('\n');

    const getSofiaResponse = require('../ai').getSofiaResponse;
    return getSofiaResponse(phone, userMessage, leadContext);
  }
}

module.exports = new AgentTechnical();
