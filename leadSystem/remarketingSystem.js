'use strict';

const { randomUUID } = require('crypto');

const db = require('../database');
const MessagingClient = require('../messagingClient');
const leadMemory = require('./leadMemory');

const INTERVALO_VERIFICACAO_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPOINTMENT_STATE_PREFIX = 'agendamento_robusto:';
const CAMPAIGN_STATE_PREFIX = 'remarketing_campaign:';

const INTERESSE_LABEL = {
  queda: 'queda de cabelo',
  crescimento: 'crescimento capilar',
  caspa: 'caspa',
  oleosidade: 'oleosidade',
  outro: 'seu problema capilar',
};

const SEGMENTOS = {
  inativo: {
    scheduleDays: [30, 45],
    exhaustAfterDays: 60,
    buildMessage: (nome, interesse, tentativa) => {
      if (tentativa === 0) {
        return `Oi ${nome}! Faz um tempo que nao nos falamos. Voce ainda esta lidando com ${interesse}? So queria saber se posso te ajudar de alguma forma.`;
      }

      if (tentativa === 1) {
        return `${nome}, nosso tratamento para ${interesse} tem ajudado muita gente por aqui. Se quiser saber mais sem compromisso, e so responder esta mensagem com "quero saber".`;
      }

      return null;
    },
  },
  recusou_preco: {
    scheduleDays: [45, 60],
    exhaustAfterDays: 60,
    buildMessage: (nome, interesse, tentativa) => {
      if (tentativa === 0) {
        return `Oi ${nome}! Temos uma novidade: criamos um pacote de entrada que pode ser uma forma mais leve de comecar a tratar ${interesse}. Posso te contar mais?`;
      }

      if (tentativa === 1) {
        return `${nome}, entendemos que investimento e uma decisao importante. Por isso criamos opcoes mais flexiveis para casos de ${interesse}. Quer ver?`;
      }

      return null;
    },
  },
  recusou_timing: {
    scheduleDays: [60],
    exhaustAfterDays: 60,
    buildMessage: (nome) => `Oi ${nome}! Ha um tempo voce disse que nao era o momento. Sera que agora se encaixa melhor? Estou aqui se quiser conversar.`,
  },
  no_show: {
    scheduleDays: [14, 21],
    exhaustAfterDays: 21,
    buildMessage: (nome, _interesse, tentativa) => {
      if (tentativa === 0) {
        return `Oi ${nome}! Vi que acabou nao dando para comparecer na avaliacao. Sem problema! Quando quiser remarcar, e so me falar.`;
      }

      if (tentativa === 1) {
        return `${nome}, ainda tenho horarios disponiveis para sua avaliacao. Quer ver as opcoes?`;
      }

      return null;
    },
  },
};

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(baseDate, days) {
  return new Date(baseDate.getTime() + days * DAY_MS);
}

function formatLeadName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || /^cliente$/i.test(trimmed)) return 'voce';
  return trimmed;
}

function getInterestLabel(lead = {}) {
  const interest = lead.qualificacao?.interesse_principal
    || lead.interesse_principal
    || 'outro';
  return INTERESSE_LABEL[interest] || INTERESSE_LABEL.outro;
}

function getLastContextTimestamp(lead = {}) {
  if (!Array.isArray(lead.contexto_conversa) || lead.contexto_conversa.length === 0) {
    return null;
  }

  const lastMessage = lead.contexto_conversa[lead.contexto_conversa.length - 1];
  return normalizeDate(lastMessage?.timestamp);
}

function getLastTouchAt(lead = {}) {
  const candidates = [
    lead.ultima_interacao,
    lead.ultimo_contato,
    lead.follow_up_ultimo_envio_em,
    lead.follow_up_encerrado_em,
    lead.remarketing_ultimo_envio_em,
    getLastContextTimestamp(lead),
  ]
    .map((value) => normalizeDate(value))
    .filter(Boolean)
    .sort((left, right) => right.getTime() - left.getTime());

  return candidates[0] || null;
}

function getMotivoRecusa(lead = {}) {
  const motivo = String(lead.motivo_recusa || '').trim().toLowerCase();
  if (motivo === 'muito_caro' || motivo === 'nao_agora') {
    return motivo;
  }

  const objecao = String(
    lead.motivo_recusa
    || lead.objecao_atual
    || lead.qualificacao?.objecao_atual
    || ''
  ).trim().toLowerCase();

  if (objecao === 'preco') return 'muito_caro';
  if (objecao === 'tempo') return 'nao_agora';
  return null;
}

function getConversationStates() {
  return db.getAll('conversation_states') || {};
}

function getLatestNoShowRecord(leadId) {
  return Object.entries(getConversationStates())
    .filter(([key, record]) => key.startsWith(APPOINTMENT_STATE_PREFIX) && record?.lead_id === leadId && record?.cliente_nao_apareceu === true)
    .map(([, record]) => record)
    .sort((left, right) => {
      const rightDate = normalizeDate(right.updated_at || right.data_agendamento)?.getTime() || 0;
      const leftDate = normalizeDate(left.updated_at || left.data_agendamento)?.getTime() || 0;
      return rightDate - leftDate;
    })[0] || null;
}

function hasRecentReschedule(lead = {}, noShowRecord = null) {
  if (!noShowRecord) return false;

  const noShowAt = normalizeDate(noShowRecord.updated_at || noShowRecord.data_agendamento);
  const remarcarEm = normalizeDate(
    lead.agendado_em
    || lead.data_agendamento
    || lead.agendamento_robusto?.updated_at
  );

  return Boolean(noShowAt && remarcarEm && remarcarEm > noShowAt);
}

function getAttemptCount(lead = {}, segmento) {
  if (lead.segmento_remarketing !== segmento) {
    return 0;
  }

  return Math.max(0, Number(lead.tentativas_remarketing) || 0);
}

class RemarketingSystem {
  constructor() {
    this.messaging = new MessagingClient();
    this._loopStarted = false;
    this._loopHandle = null;
  }

  async iniciarLoop() {
    if (this._loopStarted) return;

    this._loopStarted = true;
    const run = async () => {
      try {
        await this._processarElegiveis();
      } catch (error) {
        console.error(`[remarketing] Falha no loop: ${error.message}`);
      }
    };

    console.log('[remarketing] Loop iniciado. Verificando a cada 6 horas.');
    await run();
    this._loopHandle = setInterval(run, INTERVALO_VERIFICACAO_MS);
  }

  async registrarResposta(leadId, nome = null) {
    const lead = await leadMemory.getOrCreateLead(leadId, nome || 'Cliente');
    const updates = {};

    if (nome && nome !== 'Cliente' && !lead.nome) {
      updates.nome = nome;
    }

    const teveRemarketing = (Number(lead.tentativas_remarketing) || 0) > 0 || Boolean(lead.segmento_remarketing);
    if (teveRemarketing && lead.convertido_via_remarketing !== true) {
      await this.marcarConvertido(leadId, { nome, skipLeadFetch: lead });
      return { ...lead, convertido_via_remarketing: true };
    }

    await leadMemory.updateLead(leadId, updates);
    return { ...lead, ...updates };
  }

  async marcarConvertido(leadId, options = {}) {
    const now = new Date().toISOString();
    const lead = options.skipLeadFetch || await leadMemory.getOrCreateLead(leadId, options.nome || 'Cliente');
    const updates = {
      convertido_via_remarketing: true,
      data_conversao: now,
      remarketing_proximo: null,
      follow_up_proximo: null,
    };

    if (options.nome && options.nome !== 'Cliente' && !lead.nome) {
      updates.nome = options.nome;
    }

    await leadMemory.updateLead(leadId, updates);
    await this._atualizarUltimaCampanha(leadId, {
      status: 'convertido',
      respondido_em: now,
      convertido_em: now,
    });
  }

  async _processarElegiveis(now = new Date()) {
    console.log('[remarketing] Verificando leads elegiveis...');
    const leads = await this._buscarLeadsElegiveis(now);

    if (leads.length > 0) {
      console.log(`[remarketing] ${leads.length} lead(s) elegivel(is)`);
    }

    for (const lead of leads) {
      try {
        await this._processarLead(lead, now);
      } catch (error) {
        console.error(`[remarketing] Erro no lead ${lead.lead_id || lead.telefone}: ${error.message}`);
      }
    }

    return leads;
  }

  async _buscarLeadsElegiveis(now = new Date()) {
    const allLeads = Object.values(db.getAll('leads') || {});

    return allLeads
      .map((lead) => this._resolverElegibilidade(lead, now))
      .filter(Boolean)
      .sort((left, right) => left._remarketing.dueAt.getTime() - right._remarketing.dueAt.getTime());
  }

  _resolverElegibilidade(lead, now = new Date()) {
    if (!lead || (!lead.lead_id && !lead.telefone)) return null;
    if (lead.convertido_via_remarketing === true) return null;
    if (lead.etapa_funil === 'remarketing_esgotado') return null;

    const lastTouchAt = getLastTouchAt(lead);
    if (lastTouchAt && now.getTime() - lastTouchAt.getTime() < ACTIVE_WINDOW_MS) {
      return null;
    }

    const segmento = this._resolverSegmento(lead);
    if (!segmento || !SEGMENTOS[segmento]) return null;

    const baseAt = this._resolverBase(segmento, lead);
    if (!baseAt) return null;

    const tentativa = getAttemptCount(lead, segmento);
    const config = SEGMENTOS[segmento];
    const dueAt = tentativa < config.scheduleDays.length
      ? addDays(baseAt, config.scheduleDays[tentativa])
      : addDays(baseAt, config.exhaustAfterDays);

    if (dueAt > now) return null;

    return {
      ...lead,
      _remarketing: {
        segmento,
        tentativa,
        dueAt,
        baseAt,
      },
    };
  }

  _resolverSegmento(lead) {
    const leadId = lead.lead_id || lead.telefone;
    const noShowRecord = getLatestNoShowRecord(leadId);
    if (noShowRecord && !hasRecentReschedule(lead, noShowRecord)) {
      return 'no_show';
    }

    const motivoRecusa = getMotivoRecusa(lead);
    if (motivoRecusa === 'muito_caro') return 'recusou_preco';
    if (motivoRecusa === 'nao_agora') return 'recusou_timing';

    if (['inativo', 'remarketing_pendente'].includes(lead.etapa_funil) || lead.remarketing_proximo) {
      return 'inativo';
    }

    return null;
  }

  _resolverBase(segmento, lead) {
    if (lead.segmento_remarketing === segmento && lead.remarketing_base_em) {
      return normalizeDate(lead.remarketing_base_em);
    }

    if (segmento === 'inativo') {
      if (lead.remarketing_proximo && !lead.remarketing_base_em) {
        const remarketingProximo = normalizeDate(lead.remarketing_proximo);
        if (remarketingProximo) {
          return addDays(remarketingProximo, -30);
        }
      }

      return normalizeDate(lead.follow_up_encerrado_em)
        || normalizeDate(lead.follow_up_cancelado_em)
        || getLastTouchAt(lead);
    }

    if (segmento === 'recusou_preco' || segmento === 'recusou_timing') {
      return normalizeDate(lead.follow_up_iniciado_em)
        || normalizeDate(lead.primeiro_contato)
        || getLastTouchAt(lead);
    }

    if (segmento === 'no_show') {
      const noShowRecord = getLatestNoShowRecord(lead.lead_id || lead.telefone);
      return normalizeDate(noShowRecord?.updated_at || noShowRecord?.data_agendamento);
    }

    return null;
  }

  async _processarLead(lead, now = new Date()) {
    const leadId = lead.lead_id || lead.telefone;
    const { segmento, tentativa, baseAt } = lead._remarketing;
    const config = SEGMENTOS[segmento];
    const nome = formatLeadName(lead.nome);
    const interesse = getInterestLabel(lead);
    const mensagem = config.buildMessage(nome, interesse, tentativa);

    if (!mensagem) {
      await this._encerrarRemarketing(leadId, segmento);
      return;
    }

    const envio = await this.messaging.sendMessage(leadId, mensagem);
    const status = envio?.queued === false ? 'nao_enviado' : 'enviado';

    await leadMemory.saveContext(leadId, mensagem, false);
    await this._registrarCampanha({
      leadId,
      segmento,
      mensagem,
      status,
      enviadoEm: now.toISOString(),
    });

    const nextAttempt = tentativa + 1;
    const nextDueAt = nextAttempt < config.scheduleDays.length
      ? addDays(baseAt, config.scheduleDays[nextAttempt]).toISOString()
      : addDays(baseAt, config.exhaustAfterDays).toISOString();

    await leadMemory.updateLead(leadId, {
      segmento_remarketing: segmento,
      tentativas_remarketing: nextAttempt,
      convertido_via_remarketing: false,
      remarketing_base_em: baseAt.toISOString(),
      remarketing_ultimo_envio_em: now.toISOString(),
      remarketing_proximo: nextDueAt,
    });
  }

  async _encerrarRemarketing(leadId, segmento) {
    await leadMemory.updateLead(leadId, {
      etapa_funil: 'remarketing_esgotado',
      segmento_remarketing: segmento,
      remarketing_proximo: null,
    });
    console.log(`[remarketing] Lead ${leadId} marcado como remarketing_esgotado`);
  }

  async _registrarCampanha({ leadId, segmento, mensagem, status, enviadoEm }) {
    const campaign = {
      id: randomUUID(),
      lead_id: leadId,
      segmento,
      mensagem,
      canal: 'whatsapp',
      status,
      enviado_em: enviadoEm || new Date().toISOString(),
      criado_em: new Date().toISOString(),
    };

    db.set('conversation_states', `${CAMPAIGN_STATE_PREFIX}${campaign.id}`, campaign);

    try {
      await db.query(
        `INSERT INTO remarketing_campaigns (lead_id, segmento, mensagem, canal, status)
         VALUES ($1, $2, $3, 'whatsapp', $4)`,
        [leadId, segmento, mensagem, status]
      );
    } catch (error) {
      if (!/DATABASE_URL/i.test(error.message)) {
        console.warn(`[remarketing] Historico SQL indisponivel para ${leadId}: ${error.message}`);
      }
    }

    return campaign;
  }

  async _atualizarUltimaCampanha(leadId, patch = {}) {
    const campaigns = this.getFallbackCampaigns(leadId)
      .sort((left, right) => {
        const rightDate = normalizeDate(right.enviado_em)?.getTime() || 0;
        const leftDate = normalizeDate(left.enviado_em)?.getTime() || 0;
        return rightDate - leftDate;
      });

    if (campaigns.length > 0) {
      const current = campaigns[0];
      db.set('conversation_states', `${CAMPAIGN_STATE_PREFIX}${current.id}`, {
        ...current,
        ...patch,
      });
    }

    try {
      await db.query(
        `UPDATE remarketing_campaigns
            SET status = $2,
                respondido_em = COALESCE($3::timestamp, respondido_em),
                convertido_em = COALESCE($4::timestamp, convertido_em)
          WHERE id = (
            SELECT id
              FROM remarketing_campaigns
             WHERE lead_id = $1
             ORDER BY enviado_em DESC
             LIMIT 1
          )`,
        [leadId, patch.status || 'convertido', patch.respondido_em || null, patch.convertido_em || null]
      );
    } catch (error) {
      if (!/DATABASE_URL/i.test(error.message)) {
        console.warn(`[remarketing] Atualizacao SQL indisponivel para ${leadId}: ${error.message}`);
      }
    }
  }

  getFallbackCampaigns(leadId = null) {
    return Object.entries(getConversationStates())
      .filter(([key]) => key.startsWith(CAMPAIGN_STATE_PREFIX))
      .map(([, value]) => value)
      .filter((campaign) => !leadId || campaign.lead_id === leadId);
  }
}

const remarketingSystem = new RemarketingSystem();

module.exports = remarketingSystem;
module.exports.RemarketingSystem = RemarketingSystem;
module.exports.constants = {
  INTERVALO_VERIFICACAO_MS,
  DAY_MS,
};