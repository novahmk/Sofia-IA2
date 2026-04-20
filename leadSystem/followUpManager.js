const leadMemory = require('./leadMemory');

class FollowUpManager {
  async scheduleFollowUp(phone, days = 3, reason = "sem_resposta") {
    const lead = await leadMemory.getOrCreateLead(phone);

    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + days);

    await leadMemory.updateLead(phone, {
      proximo_follow_up: nextDate.toISOString(),
      follow_up_count: (lead.follow_up_count || 0) + 1,
      etapa_funil: "follow_up"
    });

    console.log(`[FOLLOW-UP] Agendado para ${phone} em ${days} dias. Motivo: ${reason}`);
    
    // TODO: Aqui você pode chamar WasenderAPI para enviar mensagem automática no futuro
    return nextDate;
  }

  async getLeadsReadyForFollowUp() {
    // Implementação futura (pode rodar via cron no Railway)
    return [];
  }
}

module.exports = new FollowUpManager();