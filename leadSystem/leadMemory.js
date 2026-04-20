const db = require('../database');
const LeadState = require('./leadState');

class LeadMemory {
  async getOrCreateLead(phone, name = "Cliente") {
    const result = await db.query(
      'SELECT data FROM leads WHERE lead_id = $1',
      [phone]
    );

    if (result.rows.length > 0) {
      return result.rows[0].data;
    }

    const newLead = LeadState.createNew(phone, name);

    await db.query(
      'INSERT INTO leads (lead_id, data) VALUES ($1, $2) ON CONFLICT (lead_id) DO UPDATE SET data = $2',
      [phone, newLead]
    );

    return newLead;
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