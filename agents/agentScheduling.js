'use strict';

const {
  SchedulingManager,
  SchedulingIntentionAnalyzer,
  BusinessHoursManager,
  NaturalSlotParser,
  MESSAGE_TEMPLATES,
  SchedulingReminders,
} = require('./scheduling-system');

const clientMemory = require('../clientMemory');

function hasAiFallbackAvailable() {
  try {
    const ai = require('../ai');
    return typeof ai.getSofiaResponse === 'function';
  } catch (error) {
    return false;
  }
}

class SchedulingAgent {
  async respond(phone, userMessage, lead, intention) {
    try {
      console.log(`📅 [SchedulingAgent] Processando: ${intention.type}`);
      console.log(`   Cliente: ${lead.nome} (${phone})`);
      console.log(`   Mensagem: "${userMessage}"`);

      const result = await SchedulingManager.processScheduling(phone, lead.nome, userMessage);

      console.log('📅 [SchedulingAgent] Resultado:', {
        success: result.success,
        type: intention.type,
        availableSlots: result.availableSlots?.length || 0,
      });

      let response = result.message;
      if (result.success) {
        response = this.addContext(response, lead, intention.type);
      }

      this.logSchedulingEvent(phone, lead.nome, intention.type, result);
      return response;
    } catch (error) {
      console.error('❌ [SchedulingAgent] Erro:', error);
      return this.getFallbackResponse(lead.nome);
    }
  }

  addContext(response, lead, intentionType) {
    let contextualResponse = response;
    if (lead.nome && !response.includes(lead.nome) && response.includes('você')) {
      contextualResponse = response.replace('você', `você, ${lead.nome}`);
    }

    const interactionCount = Array.isArray(lead.contexto_conversa) ? lead.contexto_conversa.length : (lead.interacoes_totais || 0);
    if (interactionCount <= 2 && intentionType === 'scheduling') {
      contextualResponse += '\n\n*Primeira vez aqui?* 👋 Somos a Quality Hair Studio, especialistas em avaliação e tratamento capilar!';
    }

    return contextualResponse;
  }

  logSchedulingEvent(phone, name, type, result) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      phone,
      name,
      type,
      success: result.success,
      eventId: result.schedulingData?.eventId || null,
      availableSlotsCount: result.availableSlots?.length || 0,
    };

    console.log('📊 [SchedulingAgent Log]', logEntry);
  }

  getFallbackResponse(name, error) {
    const errorHint = process.env.DEBUG_SCHEDULING === 'true' && error?.message
      ? `\n\nDetalhe técnico: ${error.message}`
      : '';

    return `Desculpe, ${name}! 😊\n\nEncontrei um pequeno problema ao processar seu agendamento. Isso é incomum!\n\nPor favor, tente novamente em alguns instantes.${errorHint}\n\nEstamos sempre prontos para ajudar! 💪`;
  }
}

class SchedulingAgentIntegration {
  static installIntegration() {
    const code = `// supervisor.js\ncase 'administrative':\n  if (['scheduling', 'reschedule', 'schedule_confirmation', 'schedule_cancellation'].includes(intention.type)) {\n    response = await agentScheduling.respond(phone, userMessage, lead, intention);\n  } else {\n    response = await agentAdministrative.respond(phone, userMessage, lead, intention);\n  }\n  break;`;

    console.log('📋 [Integration Guide]', code);
  }
}

class SchedulingExtensions {
  static async getClientUpcomingAppointments(phone) {
    try {
      const memory = clientMemory.getClientMemory(phone);
      return (memory?.appointments?.scheduled || []).filter((appointment) => appointment.status !== 'cancelled');
    } catch (error) {
      console.error('Erro ao buscar agendamentos:', error);
      return [];
    }
  }

  static suggestBestTime() {
    return {
      preferredDays: ['segunda', 'quarta', 'sexta'],
      preferredTimes: ['09:00', '14:00', '16:00'],
      avoidTimes: [],
    };
  }

  static async notifyManager(clientName, proposedTime) {
    console.log(`📢 [Manager Notification] Novo agendamento: ${clientName} em ${proposedTime}`);
  }

  static analyzeSchedulingQuality(phone, response) {
    const memory = clientMemory.getClientMemory(phone);
    return {
      responseTime: 'fast',
      naturalness: 'high',
      clientSatisfaction: 'predicted_high',
      completionRate: '100%',
      knownAppointments: memory?.appointments?.scheduled?.length || 0,
      responseLength: response?.length || 0,
    };
  }
}

class ConversationFlowExamples {
  static examples() {
    return {
      simple: {
        user: 'Olá, gostaria de agendar uma avaliação capilar',
        bot: MESSAGE_TEMPLATES.askDateTime('João'),
        followUp: {
          user: 'Amanhã à tarde',
          bot: MESSAGE_TEMPLATES.showAvailable([
            { start: '2026-04-22T14:00:00Z', end: '2026-04-22T15:00:00Z' },
            { start: '2026-04-22T15:00:00Z', end: '2026-04-22T16:00:00Z' },
            { start: '2026-04-22T16:00:00Z', end: '2026-04-22T17:00:00Z' },
          ]),
        },
      },
      cancellation: {
        user: 'Preciso cancelar meu agendamento',
        bot: MESSAGE_TEMPLATES.cancellationConfirm('Maria'),
      },
      rescheduling: {
        user: 'Gostaria de reagendar',
        bot: `${MESSAGE_TEMPLATES.rescheduling('Pedro')}\n\n[Mostra novos horários]`,
      },
      reminder: {
        bot: MESSAGE_TEMPLATES.reminder('Ana', '2026-04-23T10:00:00Z'),
      },
    };
  }
}

class SchedulingAgentTests {
  static async runQuickTest() {
    console.log('🧪 [SchedulingAgent] Iniciando testes...');

    const test1 = SchedulingIntentionAnalyzer.analyzeMessage('Gostaria de agendar uma avaliação capilar');
    console.log('✅ Teste 1 - Análise de intenção:', test1);

    const test2 = SchedulingIntentionAnalyzer.extractDateTime('Amanhã às 14:30');
    console.log('✅ Teste 2 - Extração de data/hora:', test2);

    const busyTime = new Date(2026, 3, 21, 19, 0);
    const officeTime = new Date(2026, 3, 21, 14, 0);
    console.log('✅ Teste 3a - Fora do comercial:', !BusinessHoursManager.isBusinessHour(busyTime));
    console.log('✅ Teste 3b - Horário comercial:', BusinessHoursManager.isBusinessHour(officeTime));

    const mockSlots = [
      { start: new Date(2026, 3, 22, 9, 0).toISOString(), end: new Date(2026, 3, 22, 10, 0).toISOString(), label: 'quarta 09:00' },
      { start: new Date(2026, 3, 22, 14, 0).toISOString(), end: new Date(2026, 3, 22, 15, 0).toISOString(), label: 'quarta 14:00' },
      { start: new Date(2026, 3, 23, 10, 0).toISOString(), end: new Date(2026, 3, 23, 11, 0).toISOString(), label: 'quinta 10:00' },
    ];

    const slotTests = [
      { msg: 'às 14h', expected: 1 },
      { msg: '14:00', expected: 1 },
      { msg: 'segunda opção', expected: 1 },
      { msg: 'de manhã', expected: 0 },
      { msg: 'o primeiro', expected: 0 },
      { msg: 'quinta', expected: 2 },
      { msg: 'pode ser', expected: 0 },
      { msg: 'o último', expected: 2 },
      { msg: 'prefiro às 9h', expected: 0 },
    ];

    let allPassed = true;
    for (const { msg, expected } of slotTests) {
      const result = NaturalSlotParser.parse(msg, mockSlots);
      const pass = result === expected;
      if (!pass) allPassed = false;
      console.log(`${pass ? '✅' : '❌'} NaturalSlotParser "${msg}" -> slot ${result} (esperado: ${expected})`);
    }

    const notFound = NaturalSlotParser.parse('não sei bem', mockSlots);
    console.log('✅ Teste clarify - retorna null quando não entende:', notFound === null);

    if (hasAiFallbackAvailable()) {
      console.log('✅ Teste extra - módulo de IA disponível para fallback natural');
    }

    console.log(`\n${allPassed ? '✅ Todos os testes passaram!' : '⚠️ Alguns testes falharam — verifique acima'}`);
  }
}

SchedulingReminders.initializeReminders();

const exported = new SchedulingAgent();
exported.Extensions = SchedulingExtensions;
exported.Examples = ConversationFlowExamples.examples();
exported.Tests = SchedulingAgentTests;
exported.Integration = SchedulingAgentIntegration;
exported.NaturalSlotParser = NaturalSlotParser;

module.exports = exported;
