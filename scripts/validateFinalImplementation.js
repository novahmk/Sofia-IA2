'use strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy';

const db = require('../database');
const LeadState = require('../leadSystem/leadState');
const ai = require('../ai');
const leadMemory = require('../leadSystem/leadMemory');
const followUpManager = require('../leadSystem/followUpManager');
const agendamentoRobusto = require('../leadSystem/agendamentoRobusto');
const { RemarketingSystem } = require('../leadSystem/remarketingSystem');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function resetKvTable(tableName) {
  const table = db.kvCache[tableName] || {};
  for (const key of Object.keys(table)) {
    delete table[key];
  }
}

function resetState() {
  resetKvTable('leads');
  resetKvTable('conversation_states');
  resetKvTable('client_memories');

  if (followUpManager._loopHandle) {
    clearInterval(followUpManager._loopHandle);
    followUpManager._loopHandle = null;
    followUpManager._loopStarted = false;
  }
}

function createLead(phone, patch = {}) {
  const base = LeadState.createNew(phone, patch.nome || 'Cliente');
  const lead = {
    ...base,
    ...patch,
    lead_id: phone,
    telefone: phone,
  };

  db.set('leads', phone, lead);
  return lead;
}

function isoDaysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function scenario1LeadFlow() {
  const phase1 = ai.detectConversationPhase(LeadState.createNew('5511999997001', 'Cliente'), []);
  assert(phase1 === 'phase_1_intention', `fase inicial inesperada: ${phase1}`);

  const leadPhase2 = {
    ...LeadState.createNew('5511999997002', 'Carla'),
    nome: 'Carla',
    interesse_principal: 'queda',
    qualificacao: {
      ...LeadState.createNew('tmp').qualificacao,
      interesse_principal: 'queda',
    },
  };
  const historyPhase2 = [
    { role: 'user', content: 'Oi' },
    { role: 'assistant', content: 'Oi, tudo bem? Me conta: você está buscando ajuda para queda, crescimento, caspa ou outro incômodo no couro cabeludo?' },
    { role: 'user', content: 'Estou perdendo muito cabelo' },
  ];
  const phase2 = ai.detectConversationPhase(leadPhase2, historyPhase2);
  assert(phase2 === 'phase_2_deepening', `fase 2 inesperada: ${phase2}`);

  const leadPhase3 = {
    ...leadPhase2,
    tempo_problema: '8_meses',
    qualificacao: {
      ...leadPhase2.qualificacao,
      tempo_problema: '8_meses',
      tratamento_anterior: false,
    },
  };
  const historyPhase3 = [
    ...historyPhase2,
    { role: 'assistant', content: 'Entendi. Isso está acontecendo há quanto tempo?' },
    { role: 'user', content: 'Uns 8 meses' },
  ];
  const phase3 = ai.detectConversationPhase(leadPhase3, historyPhase3);
  assert(phase3 === 'phase_3_transition', `fase 3 inesperada: ${phase3}`);

  assert(ai.systemPrompt.includes('Nunca comece com "Quer agendar?"'), 'prompt final nao reforca abertura sem agendamento');
  assert(ai.systemPrompt.includes('Nunca faça mais de 3 perguntas de qualificação antes de oferecer o próximo passo.'), 'prompt final nao limita qualificação');

  return {
    status: 'ok',
    phase1,
    phase2,
    phase3,
  };
}

async function scenario2PriceObjection() {
  const lead = {
    ...LeadState.createNew('5511999997003', 'Bianca'),
    nome: 'Bianca',
    qualificacao: {
      ...LeadState.createNew('tmp2').qualificacao,
      objecao_atual: 'preco',
    },
  };

  const context = ai.buildLeadContext(lead, []);
  assert(context.includes('Objeção atual: preco'), 'contexto do lead nao expõe objeção de preço');
  assert(ai.systemPrompt.includes('Preço: explique que a avaliação é o primeiro passo'), 'prompt final nao cobre objeção de preço');

  return {
    status: 'ok',
    objectionTracked: true,
  };
}

async function scenario3ConsideringFollowUp() {
  resetState();
  const phone = '5511999997004';
  createLead(phone, {
    nome: 'Fernanda',
    etapa_funil: 'em_qualificacao',
    interesse_principal: 'queda',
    qualificacao: {
      ...LeadState.createNew('tmp3').qualificacao,
      interesse_principal: 'queda',
    },
  });

  const lead = await leadMemory.getOrCreateLead(phone, 'Fernanda');
  const motivo = await followUpManager.registrarInteracao(phone, 'Vou pensar melhor', lead);
  const updatedLead = await leadMemory.getOrCreateLead(phone);

  assert(motivo === 'considerando', `motivo esperado considerando, recebido ${motivo}`);
  assert(updatedLead.follow_up_sequencia === 'considerando', 'sequência considerando não foi iniciada');
  assert(Boolean(updatedLead.follow_up_proximo), 'follow_up_proximo deveria ser definido para considerando');
  assert(ai.systemPrompt.includes('Se o lead hesitar') && ai.systemPrompt.includes('não repita a oferta imediatamente'), 'prompt final nao cobre hesitação');

  return {
    status: 'ok',
    followUpSequence: updatedLead.follow_up_sequencia,
  };
}

async function scenario4NoShow() {
  resetState();
  const phone = '5511999997005';
  const now = new Date('2026-04-25T12:00:00.000Z');
  const messages = [];
  const originalSendMessage = followUpManager.messaging.sendMessage.bind(followUpManager.messaging);
  followUpManager.messaging.sendMessage = async (targetPhone, message) => {
    messages.push({ phone: targetPhone, message });
    return { queued: true };
  };

  try {
    createLead(phone, { nome: 'Diego' });

    await agendamentoRobusto.saveAppointmentRecord({
      uuid: 'smoke-no-show',
      lead_id: phone,
      data_agendamento: '2026-04-25T09:00:00.000Z',
      status_confirmacao: 'confirmado',
      cliente_nao_apareceu: false,
    });

    await agendamentoRobusto._verificarNoShow('smoke-no-show', phone);
    const appointment = agendamentoRobusto.getAppointmentRecord('smoke-no-show');
    let lead = await leadMemory.getOrCreateLead(phone);

    assert(appointment?.cliente_nao_apareceu === true, 'no-show não foi marcado no agendamento');
    assert(lead.follow_up_sequencia === 'no_show', 'sequência de no-show não foi iniciada');

    await leadMemory.updateLead(phone, { follow_up_proximo: now.toISOString() });
    lead = await leadMemory.getOrCreateLead(phone);
    await followUpManager._processarLead(lead, now);

    await leadMemory.updateLead(phone, { follow_up_proximo: now.toISOString() });
    lead = await leadMemory.getOrCreateLead(phone);
    await followUpManager._processarLead(lead, now);

    await leadMemory.updateLead(phone, { follow_up_proximo: now.toISOString() });
    lead = await leadMemory.getOrCreateLead(phone);
    await followUpManager._processarLead(lead, now);

    const finalLead = await leadMemory.getOrCreateLead(phone);

    assert(messages.length === 2, `no-show deveria ter 2 tentativas, recebeu ${messages.length}`);
    assert(/Sem problema|sem problema/i.test(messages[0].message), 'primeira mensagem de no-show deveria ser sem julgamento');
    assert(/remarcar|horarios disponiveis/i.test(messages[1].message), 'segunda mensagem de no-show deveria oferecer remarcação');
    assert(finalLead.follow_up_sequencia === null, 'sequência de no-show deveria encerrar após 2 tentativas');

    return {
      status: 'ok',
      attempts: messages.length,
      finalStage: finalLead.etapa_funil,
    };
  } finally {
    followUpManager.messaging.sendMessage = originalSendMessage;
  }
}

async function scenario5RemarketingReactivation() {
  resetState();
  const phone = '5511999997006';
  const now = new Date('2026-04-25T12:00:00.000Z');
  const system = new RemarketingSystem();
  const sent = [];
  system.messaging.sendMessage = async (targetPhone, message) => {
    sent.push({ phone: targetPhone, message });
    return { queued: true };
  };

  createLead(phone, {
    nome: 'Elisa',
    etapa_funil: 'inativo',
    follow_up_ultimo_motivo: 'sem_resposta',
    follow_up_encerrado_em: isoDaysAgo(now, 31),
    ultima_interacao: isoDaysAgo(now, 31),
    remarketing_proximo: isoDaysAgo(now, 1),
    qualificacao: {
      ...LeadState.createNew('tmp4').qualificacao,
      interesse_principal: 'queda',
      tempo_problema: '1_ano',
    },
    contexto_conversa: [
      { role: 'user', content: 'Tenho muita queda faz meses', timestamp: isoDaysAgo(now, 35) },
      { role: 'assistant', content: 'Entendi. Isso está acontecendo há quanto tempo?', timestamp: isoDaysAgo(now, 35) },
    ],
  });

  await system._processarElegiveis(now);
  const afterCampaignLead = await leadMemory.getOrCreateLead(phone);
  assert(sent.length === 1, `remarketing deveria enviar 1 mensagem, recebeu ${sent.length}`);
  assert(afterCampaignLead.segmento_remarketing === 'inativo', 'segmento de remarketing deveria ser inativo');

  await system.registrarResposta(phone, 'Elisa');
  const convertedLead = await leadMemory.getOrCreateLead(phone);
  const restoredHistory = ai.buildInitialChatHistory('SYSTEM', convertedLead);

  assert(convertedLead.convertido_via_remarketing === true, 'lead deveria ser marcado como convertido via remarketing');
  assert(restoredHistory.length > 2, 'histórico deveria ser restaurado para retomada de conversa');
  assert(restoredHistory.some((message) => message.content.includes('Tenho muita queda faz meses')), 'histórico restaurado deveria manter contexto anterior');

  return {
    status: 'ok',
    campaignsSent: sent.length,
    restoredMessages: restoredHistory.length - 1,
  };
}

async function main() {
  const results = {
    scenario1: await scenario1LeadFlow(),
    scenario2: await scenario2PriceObjection(),
    scenario3: await scenario3ConsideringFollowUp(),
    scenario4: await scenario4NoShow(),
    scenario5: await scenario5RemarketingReactivation(),
  };

  console.log(JSON.stringify(results, null, 2));
  console.log('FINAL_IMPLEMENTATION_SMOKE_OK');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});