/**
 * SUPERVISOR — Orquestrador Multi-Agent
 * ══════════════════════════════════════════════════════════
 * Substitui commercialFlow.processMessage como ponto de entrada.
 *
 * Fluxo:
 * 1. Carrega/cria lead (leadMemory)
 * 2. Salva mensagem do usuário
 * 3. Detecta progressão de funil
 * 4. Analisa intenção (fast, sem chamada API)
 * 5. Roteia para agente especializado
 * 6. Salva resposta e atualiza lead
 * 7. Agenda follow-up (se primeiro contato)
 * 8. Dispara feedback loop em background
 */

'use strict';

const leadMemory = require('../leadSystem/leadMemory');
const followUpManager = require('../leadSystem/followUpManager');
const agentContext = require('./agentContext');
const agentCommercial = require('./agentCommercial');
const agentTechnical = require('./agentTechnical');
const agentAdministrative = require('./agentAdministrative');
const selfImprovement = require('../improvement/selfImprovement');

// Mesma lógica de progressão de funil do commercialFlow (mantém compatibilidade)
function detectFunnelProgression(lead, userMessage) {
  const msg = userMessage.toLowerCase();
  let newStage = lead.etapa_funil;

  if (lead.etapa_funil === 'novo') {
    if (
      msg.includes('interesse') ||
      msg.includes('quero') ||
      msg.includes('gostaria') ||
      msg.includes('preciso')
    ) {
      newStage = 'qualificado';
    }
  } else if (lead.etapa_funil === 'qualificado') {
    if (
      msg.includes('agendar') ||
      msg.includes('marcar') ||
      msg.includes('horário') ||
      msg.includes('quando')
    ) {
      newStage = 'proposta';
    }
  } else if (lead.etapa_funil === 'proposta') {
    if (msg.includes('confirmo') || msg.includes('aceito') || msg.includes('fechar')) {
      newStage = 'negociacao';
    }
  }

  return newStage;
}

class SupervisorAgent {
  /**
   * Processa mensagem completa — entry point principal
   * Assinatura idêntica a commercialFlow.processMessage para drop-in replacement.
   *
   * @param {string} phone
   * @param {string} userMessage
   * @param {string} name
   * @returns {Promise<{ response: string, lead: object }>}
   */
  async processMessage(phone, userMessage, name = 'Cliente') {
    const start = Date.now();

    // 1. Carrega/cria lead
    const lead = await leadMemory.getOrCreateLead(phone, name);

    // 2. Salva mensagem do usuário no histórico do lead
    await leadMemory.saveContext(phone, userMessage, true);

    // 3. Detecta progressão de funil
    const newStage = detectFunnelProgression(lead, userMessage);
    if (newStage !== lead.etapa_funil) {
      await leadMemory.updateLead(phone, { etapa_funil: newStage });
      lead.etapa_funil = newStage;
    }

    // 4. Análise de intenção (síncrona, sem custo de API)
    const intention = agentContext.analyzeIntention(userMessage, lead);
    console.log(
      `🎯 [Supervisor] Agente: ${intention.agent} | Intenção: ${intention.type}`
    );

    // 5. Roteia para agente especializado
    let response;
    try {
      switch (intention.agent) {
        case 'commercial':
          response = await agentCommercial.respond(phone, userMessage, lead, intention);
          break;
        case 'technical':
          response = await agentTechnical.respond(phone, userMessage, lead, intention);
          break;
        case 'administrative':
          response = await agentAdministrative.respond(phone, userMessage, lead, intention);
          break;
        default:
          response = await agentContext.respond(phone, userMessage, lead, intention);
      }
    } catch (agentError) {
      console.error(`⚠️ [Supervisor] Agente ${intention.agent} falhou: ${agentError.message} — usando fallback`);
      response = await agentContext.respond(phone, userMessage, lead, intention);
    }

    // 6. Persiste resposta e atualiza lead
    await leadMemory.saveContext(phone, response, false);
    await leadMemory.updateLead(phone, { etapa_funil: lead.etapa_funil });

    // 7. Agenda follow-up automático no primeiro contato
    if (lead.etapa_funil === 'novo' && (lead.follow_up_count || 0) === 0) {
      await followUpManager.scheduleFollowUp(phone, 2, 'primeiro_contato');
    }

    // 8. Feedback loop em background (não bloqueia resposta)
    const latency = Date.now() - start;
    setImmediate(() => {
      selfImprovement.analyze(phone, userMessage, response, {
        agentUsed: intention.agent,
        intentionType: intention.type,
        latencyMs: latency,
        leadStage: lead.etapa_funil,
      });
    });

    const updatedLead = await leadMemory.getOrCreateLead(phone);
    return { response, lead: updatedLead };
  }
}

module.exports = new SupervisorAgent();
