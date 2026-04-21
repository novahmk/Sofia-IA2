/**
 * AGENTE ADMINISTRATIVO — Agendamento e dados do cliente
 * ══════════════════════════════════════════════════════════
 * - Especializado em agendamentos, cancelamentos, remarcações
 * - Delega para getSofiaResponse com foco em usar as tool calls do Feegow
 *   (check_available_appointments e book_appointment já estão no functionCalling.js)
 */

'use strict';

const ADMIN_CONTEXTS = {
  scheduling: [
    '[AGENTE ADMINISTRATIVO — AGENDAMENTO]',
    'Modo operacional: assistente de agendamento',
    'Regras:',
    '1. Use check_available_appointments para buscar horários reais ANTES de sugerir qualquer data',
    '2. Apresente 3-5 opções de horário de forma clara e numerada',
    '3. Quando cliente confirmar data+horário, use book_appointment',
    '4. Dados necessários para agendar: nome completo, data, horário, procedimento',
    '5. Confirme cada dado com o cliente antes de executar o agendamento',
    '[FIM DO CONTEXTO ADMINISTRATIVO]',
  ].join('\n'),

  reschedule: [
    '[AGENTE ADMINISTRATIVO — REMARCAÇÃO/CANCELAMENTO]',
    'Modo operacional: assistente de remarcação',
    'Regras:',
    '1. Confirme qual agendamento o cliente quer alterar (data/horário atual)',
    '2. Se remarcação: use check_available_appointments para novos horários',
    '3. Seja compreensiva — não questione o motivo do cancelamento',
    '4. Se cancelamento: confirme e ofereça reagendar futuramente',
    '[FIM DO CONTEXTO ADMINISTRATIVO]',
  ].join('\n'),

  data_update: [
    '[AGENTE ADMINISTRATIVO — ATUALIZAÇÃO DE DADOS]',
    'Modo operacional: assistente de cadastro',
    'Regras:',
    '1. Confirme qual dado o cliente quer atualizar',
    '2. Solicite o novo valor de forma clara',
    '3. Confirme antes de salvar',
    '[FIM DO CONTEXTO ADMINISTRATIVO]',
  ].join('\n'),
};

class AgentAdministrative {
  /**
   * Responde com foco em agendamento e dados
   * @param {string} phone
   * @param {string} userMessage
   * @param {object} lead
   * @param {{ type: string }} intention
   * @returns {Promise<string>}
   */
  async respond(phone, userMessage, lead, intention) {
    console.log(`📅 [AgentAdmin] tipo: ${intention.type}`);

    const adminCtx = ADMIN_CONTEXTS[intention.type] || ADMIN_CONTEXTS.scheduling;

    const historico = (lead.contexto_conversa || [])
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${m.content}`)
      .join('\n');

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      historico ? `\nHistórico:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
      adminCtx,
    ]
      .filter(Boolean)
      .join('\n');

    const getSofiaResponse = require('../ai').getSofiaResponse;
    return getSofiaResponse(phone, userMessage, leadContext);
  }
}

module.exports = new AgentAdministrative();
