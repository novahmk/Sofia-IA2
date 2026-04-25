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
      'etapa_funil',
      'status',
      'intencao',
      'score',
      'lead_score',
      'temperatura',
      'nivel_qualificacao',
      'motivo_recusa',
      'segmento_remarketing',
      'tentativas_remarketing',
      'convertido_via_remarketing',
      'data_conversao',
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

    const updates = {
      contexto_conversa: lead.contexto_conversa,
      ultimo_mensagem: message.substring(0, 500),
    };

    if (isUser) {
      updates.total_mensagens_usuario = (lead.total_mensagens_usuario || 0) + 1;
    } else {
      updates.total_mensagens_assistente = (lead.total_mensagens_assistente || 0) + 1;
    }

    await this.updateLead(phone, updates);
  }

  async clearAllConversationHistory() {
    const leads = db.getAll('leads') || {};
    let clearedLeads = 0;

    for (const [phone, lead] of Object.entries(leads)) {
      if (!lead) continue;

      const nextLead = { ...lead };
      let updated = false;

      if (Array.isArray(nextLead.contexto_conversa) && nextLead.contexto_conversa.length > 0) {
        nextLead.contexto_conversa = [];
        updated = true;
      }

      if (nextLead.resumo_conversa) {
        nextLead.resumo_conversa = null;
        updated = true;
      }

      if (updated) {
        db.set('leads', phone, nextLead);
        clearedLeads += 1;
      }
    }

    return { clearedLeads };
  }
}

module.exports = new LeadMemory();