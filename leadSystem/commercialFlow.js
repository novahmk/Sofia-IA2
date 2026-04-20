const leadMemory = require('./leadMemory');
const followUpManager = require('./followUpManager');

class CommercialFlow {
  async processMessage(phone, userMessage, name = 'Cliente') {
    const lead = await leadMemory.getOrCreateLead(phone, name);

    await leadMemory.saveContext(phone, userMessage, true);

    let response = 'Entendi. Me conta um pouco mais sobre o que voce procura para eu te ajudar melhor.';
    let newStage = lead.etapa_funil;
    const normalizedMessage = userMessage.toLowerCase();

    if (normalizedMessage.includes('interesse') || normalizedMessage.includes('quero')) {
      newStage = 'qualificado';
      response = `Otimo, ${lead.nome}! Entendi seu interesse. Qual o principal objetivo que voce quer alcancar?`;
    } else if (lead.etapa_funil === 'qualificado') {
      newStage = 'proposta';
      response = 'Perfeito! Vou te enviar uma proposta personalizada. Me confirma seu e-mail?';
    } else if (lead.etapa_funil === 'proposta') {
      newStage = 'negociacao';
      response = 'Entendido. Vamos negociar os valores. Qual sua expectativa de investimento?';
    }

    if (newStage !== lead.etapa_funil) {
      await leadMemory.updateLead(phone, { etapa_funil: newStage });
    }

    if (newStage === 'novo' && lead.follow_up_count === 0) {
      await followUpManager.scheduleFollowUp(phone, 2, 'primeiro_contato');
    }

    await leadMemory.saveContext(phone, response, false);

    return { response, lead: await leadMemory.getOrCreateLead(phone) };
  }
}

module.exports = new CommercialFlow();