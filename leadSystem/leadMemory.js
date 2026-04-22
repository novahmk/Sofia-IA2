const db = require('../database');
const leadDB = require('../leadDB');
const LeadState = require('./leadState');

class LeadMemory {
  async getOrCreateLead(phone, name = "Cliente") {
    const baseLead = LeadState.createNew(phone, name);
    const lead = await leadDB.buscarOuCriarLead(phone);
    const mergedLead = {
      ...baseLead,
      ...(lead || {}),
      telefone: phone,
      lead_id: phone,
    };

    if (name && name !== 'Cliente' && !mergedLead.nome) {
      await leadDB.atualizarLead(phone, { nome: name });
      mergedLead.nome = name;
    }

    return mergedLead;
  }

  async updateLead(phone, updates) {
    const lead = await this.getOrCreateLead(phone);
    const updatedLead = {
      ...lead,
      ...updates,
      ultima_interacao: new Date().toISOString()
    };

    await db.query(
      'UPDATE leads SET data = $1 WHERE lead_id = $2',
      [updatedLead, phone]
    );

    const structuredUpdates = {};
    const structuredFields = [
      'status',
      'intencao',
      'score',
      'procedimento_interesse',
      'resumo_conversa',
      'agendado_em',
      'follow_up_count',
      'follow_up_proximo',
      'redirecionado_comercial',
      'nome',
    ];

    for (const field of structuredFields) {
      if (field in updates) {
        structuredUpdates[field] = updates[field];
      }
    }

    if (Object.keys(structuredUpdates).length > 0) {
      await leadDB.atualizarLead(phone, structuredUpdates);
    }

    return updatedLead;
  }

  async saveContext(phone, message, isUser = true) {
    const lead = await this.getOrCreateLead(phone);
    lead.contexto_conversa = lead.contexto_conversa || [];

    lead.contexto_conversa.push({
      role: isUser ? "user" : "assistant",
      content: message.substring(0, 500), // limita tamanho
      timestamp: new Date().toISOString()
    });

    // Mantém só as últimas 12 mensagens
    if (lead.contexto_conversa.length > 12) {
      lead.contexto_conversa.shift();
    }

    await this.updateLead(phone, { contexto_conversa: lead.contexto_conversa });
  }
}

module.exports = new LeadMemory();