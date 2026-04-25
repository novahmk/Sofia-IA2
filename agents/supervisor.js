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
const leadDB = require('../leadDB');
const agentContext = require('./agentContext');
const agentCommercial = require('./agentCommercial');
const agentTechnical = require('./agentTechnical');
const agentAdministrative = require('./agentAdministrative');
const agentScheduling = require('./agentScheduling');
const selfImprovement = require('../improvement/selfImprovement');
const eventBus = require('../eventBus');
const { processarQualificacao } = require('../leadSystem/qualificacaoCapilar');
const followUpManager = require('../leadSystem/followUpManager');
const scoringEngine = require('../leadSystem/leadScoringEngine');

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
  async processMessage(phone, userMessage, name = 'Cliente', precomputedIntention = null, runtimeContext = {}) {
    const start = Date.now();

    // 1. Carrega/cria lead
    const lead = {
      ...(await leadMemory.getOrCreateLead(phone, name)),
      ...runtimeContext,
    };
    const followUpReason = await followUpManager.registrarInteracao(phone, userMessage, lead);

    // 2. Processa qualificação capilar progressiva (substitui regex)
    const qualificationHistory = [
      ...(lead.contexto_conversa || []),
      { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
    ];
    const qualificationResult = await processarQualificacao(lead, userMessage, qualificationHistory);
    if (qualificationResult.status === 'ok') {
      lead.etapa_funil = qualificationResult.etapaFunil;
      lead.qualificacao = qualificationResult.qualificacao;
    }

    // 3. Análise de intenção (síncrona, sem custo de API)
    const intention = precomputedIntention || await agentContext.analyzeIntentionWithAI(userMessage, lead);
    console.log(
      `🎯 [Supervisor] Agente: ${intention.agent} | Intenção: ${intention.type}${intention.source ? ` | Fonte: ${intention.source}` : ''}`
    );

    // 4. Roteia para agente especializado
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
          if (['scheduling', 'reschedule', 'schedule_confirmation', 'schedule_cancellation'].includes(intention.type)) {
            response = await agentScheduling.respond(phone, userMessage, lead, intention);
          } else {
            response = await agentAdministrative.respond(phone, userMessage, lead, intention);
          }
          break;
        default:
          response = await agentContext.respond(phone, userMessage, lead, intention);
      }
    } catch (agentError) {
      console.error(`⚠️ [Supervisor] Agente ${intention.agent} falhou: ${agentError.message} — usando fallback`);
      response = await agentContext.respond(phone, userMessage, lead, intention);
    }

    // 5. Atualiza lead
    await leadMemory.updateLead(phone, {
      etapa_funil: lead.etapa_funil,
      qualificacao: lead.qualificacao,
    });

    setImmediate(() => {
      scoringEngine.calcularScore(phone)
        .then((scoreInfo) => {
          if (scoreInfo) {
            console.log(`[scoring] ${phone}: score=${scoreInfo.score}, temp=${scoreInfo.temperatura}`);
          }
        })
        .catch((err) => console.error('[scoring] Erro:', err.message));
    });

    // 6. Reinicia a sequência correta a partir da última interação do lead
    if (!followUpReason && ['novo', 'em_qualificacao'].includes(lead.etapa_funil)) {
      await followUpManager.iniciarSequencia(phone, 'sem_resposta');
    }

    const latency = Date.now() - start;

    // 7. Publica eventos para o dashboard (SSE)
    eventBus.publish('agent_routed', {
      phone,
      agent: intention.agent,
      intentionType: intention.type,
    });
    eventBus.publish('message_sent', {
      phone,
      nome: lead.nome,
      response: response?.substring(0, 100),
      agentUsed: intention.agent,
      intentionType: intention.type,
      latencyMs: latency,
      leadStage: lead.etapa_funil,
    });

    // 8. Feedback loop em background (não bloqueia resposta)
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
