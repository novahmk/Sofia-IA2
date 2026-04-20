const leadMemory = require('./leadMemory');
const followUpManager = require('./followUpManager');

// Lazy require para evitar problema de circular dependency no boot
let _getSofiaResponse = null;
function getSofiaFn() {
  if (!_getSofiaResponse) {
    _getSofiaResponse = require('../ai').getSofiaResponse;
  }
  return _getSofiaResponse;
}

// Detecta sinais de progressão de funil sem bloquear a IA
function detectFunnelProgression(lead, userMessage) {
  const msg = userMessage.toLowerCase();
  let newStage = lead.etapa_funil;

  if (lead.etapa_funil === 'novo') {
    if (msg.includes('interesse') || msg.includes('quero') || msg.includes('gostaria') || msg.includes('preciso')) {
      newStage = 'qualificado';
    }
  } else if (lead.etapa_funil === 'qualificado') {
    if (msg.includes('agendar') || msg.includes('marcar') || msg.includes('horário') || msg.includes('quando')) {
      newStage = 'proposta';
    }
  } else if (lead.etapa_funil === 'proposta') {
    if (msg.includes('confirmo') || msg.includes('aceito') || msg.includes('fechar')) {
      newStage = 'negociacao';
    }
  }

  return newStage;
}

class CommercialFlow {
  async processMessage(phone, userMessage, name = 'Cliente') {
    // 1. Carrega / cria o lead no banco
    const lead = await leadMemory.getOrCreateLead(phone, name);

    // 2. Persiste a mensagem do usuário no histórico do lead
    await leadMemory.saveContext(phone, userMessage, true);

    // 3. Detecta sinais de progressão de funil (não bloqueia a IA)
    const newStage = detectFunnelProgression(lead, userMessage);
    if (newStage !== lead.etapa_funil) {
      await leadMemory.updateLead(phone, { etapa_funil: newStage });
      lead.etapa_funil = newStage;
    }

    // 4. Monta bloco [CONTEXTO DO LEAD] com nome, etapa e histórico recente
    const historico = (lead.contexto_conversa || [])
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${m.content}`)
      .join('\n');

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      `Follow-ups realizados: ${lead.follow_up_count || 0}`,
      historico ? `\nHistórico recente:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
    ].filter(Boolean).join('\n');

    // 5. Chama getSofiaResponse() — o cérebro real — passando o contexto do lead
    const sofiaFn = getSofiaFn();
    const response = await sofiaFn(phone, userMessage, leadContext);

    // 6. Persiste a resposta e atualiza etapa no banco
    await leadMemory.saveContext(phone, response, false);
    await leadMemory.updateLead(phone, { etapa_funil: lead.etapa_funil });

    // 7. Agenda follow-up automático no primeiro contato sem resposta
    if (lead.etapa_funil === 'novo' && (lead.follow_up_count || 0) === 0) {
      await followUpManager.scheduleFollowUp(phone, 2, 'primeiro_contato');
    }

    return { response, lead: await leadMemory.getOrCreateLead(phone) };
  }
}

module.exports = new CommercialFlow();