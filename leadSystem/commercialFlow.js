const leadMemory = require('./leadMemory');
const followUpManager = require('./followUpManager');

class CommercialFlow {
  async processMessage(phone, userMessage, name = "Cliente") {
    const lead = await leadMemory.getOrCreateLead(phone, name);

    // Salva contexto
    await leadMemory.saveContext(phone, userMessage, true);

    // Lógica simples de transição de etapa (pode ser expandida)
    let response = "";
    let newStage = lead.etapa_funil;

    if (userMessage.toLowerCase().includes("interesse") || userMessage.toLowerCase().includes("quero")) {
      newStage = "qualificado";
      response = `Ótimo, ${lead.nome}! Entendi seu interesse. Qual o principal objetivo que você quer alcançar?`;
    } else if (lead.etapa_funil === 'qualificado') {
      newStage = "proposta";
      response = 'Perfeito! Vou te enviar uma proposta personalizada. Me confirma seu e-mail?';
    } else if (lead.etapa_funil === 'proposta') {
      newStage = "negociacao";
      response = 'Entendido. Vamos negociar os valores. Qual sua expectativa de investimento?';
    }

    // Atualiza etapa se mudou
    if (newStage !== lead.etapa_funil) {
      await leadMemory.updateLead(phone, { etapa_funil: newStage });
    }

    // Agenda follow-up automático se a conversa esfriar
    if (lead.etapa_funil === "novo" && lead.follow_up_count === 0) {
      await followUpManager.scheduleFollowUp(phone, 2, "primeiro_contato");
    }

    // Salva resposta da IA
    await leadMemory.saveContext(phone, response, false);

    return { response, lead: await leadMemory.getOrCreateLead(phone) };
  }
}

module.exports = new CommercialFlow();