const db = require('../database');
const MessagingClient = require('../messagingClient');
const leadMemory = require('./leadMemory');

const INTERVALO_VERIFICACAO_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SEQUENCIAS_VALIDAS = new Set(['sem_resposta', 'considerando', 'recusou', 'no_show']);
const ETAPAS_FINAIS = new Set(['fechado', 'inativo']);

const PADROES_CONSIDERANDO = [
  /\btalvez\b/i,
  /\bvou pensar\b/i,
  /\bpreciso pensar\b/i,
  /\bagora nao\b/i,
  /\bagora não\b/i,
  /\bdepois\b/i,
  /\bmais tarde\b/i,
  /\boutro momento\b/i,
];

const PADROES_RECUSA = [
  /nao tenho interesse/i,
  /não tenho interesse/i,
  /sem interesse/i,
  /nao quero/i,
  /não quero/i,
  /nao preciso/i,
  /não preciso/i,
  /prefiro nao/i,
  /prefiro não/i,
  /nao vou/i,
  /não vou/i,
];

const INTERESSES_LABEL = {
  queda: 'queda de cabelo',
  crescimento: 'crescimento capilar',
  caspa: 'caspa',
  oleosidade: 'oleosidade',
  outro: 'seu caso capilar',
};

const CONTEUDO_EDUCATIVO = {
  queda: 'Quando a queda persiste por semanas ou meses, uma avaliação inicial ajuda a diferenciar causas hormonais, inflamatórias e hábitos do dia a dia.',
  crescimento: 'Muita gente acha que o cabelo só cresce devagar, mas muitas vezes existe um fator no couro cabeludo que pode ser tratado cedo.',
  caspa: 'Caspa recorrente costuma ter relação com inflamação e oleosidade do couro cabeludo, e tratar cedo costuma evitar piora do desconforto.',
  oleosidade: 'Oleosidade em excesso nem sempre é só rotina de lavagem; muitas vezes vale olhar o couro cabeludo para entender o que está disparando isso.',
  outro: 'Uma avaliação inicial ajuda a entender o que está acontecendo no couro cabeludo e quais caminhos fazem sentido antes de qualquer decisão.',
};

function normalizeMessage(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatLeadName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || /^cliente$/i.test(trimmed)) return 'você';
  return trimmed;
}

function addDelay(baseDate, delayMs) {
  return new Date(baseDate.getTime() + delayMs);
}

function getLeadInterest(lead = {}) {
  return lead.qualificacao?.interesse_principal
    || lead.interesse_principal
    || 'outro';
}

function getInterestLabel(lead = {}) {
  const interest = getLeadInterest(lead);
  return INTERESSES_LABEL[interest] || 'seu problema capilar';
}

function getEducationalContent(lead = {}) {
  const interest = getLeadInterest(lead);
  return CONTEUDO_EDUCATIVO[interest] || CONTEUDO_EDUCATIVO.outro;
}

class FollowUpManager {
  constructor() {
    this.messaging = new MessagingClient();
    this._loopStarted = false;
    this._loopHandle = null;
    this.sequencias = {
      sem_resposta: this._sequenciaSemResposta.bind(this),
      considerando: this._sequenciaConsiderando.bind(this),
      recusou: this._sequenciaRecusou.bind(this),
      no_show: this._sequenciaNoShow.bind(this),
    };
  }

  detectarMotivoPorMensagem(message = '') {
    const normalized = normalizeMessage(message);
    if (!normalized) return null;

    if (PADROES_RECUSA.some((pattern) => pattern.test(normalized))) {
      return 'recusou';
    }

    if (PADROES_CONSIDERANDO.some((pattern) => pattern.test(normalized))) {
      return 'considerando';
    }

    return null;
  }

  async iniciarLoop() {
    if (this._loopStarted) return;

    this._loopStarted = true;
    const run = async () => {
      try {
        await this._processarFollowUpsPendentes();
      } catch (error) {
        console.error(`[followUpManager] Falha no loop: ${error.message}`);
      }
    };

    console.log('[followUpManager] Loop iniciado. Verificando a cada 15 minutos.');
    await run();
    this._loopHandle = setInterval(run, INTERVALO_VERIFICACAO_MS);
  }

  async iniciarSequencia(leadId, motivo, options = {}) {
    if (!SEQUENCIAS_VALIDAS.has(motivo)) {
      console.error(`[followUpManager] Motivo invalido: ${motivo}`);
      return null;
    }

    const lead = await leadMemory.getOrCreateLead(leadId);
    const firstRunAt = options.firstRunAt instanceof Date
      ? options.firstRunAt
      : this._getFirstRunDate(motivo, new Date());

    const updates = {
      follow_up_sequencia: motivo,
      follow_up_step: 0,
      follow_up_count: 0,
      follow_up_proximo: firstRunAt.toISOString(),
      follow_up_iniciado_em: new Date().toISOString(),
      follow_up_ultimo_envio_em: null,
      follow_up_cancelado_em: null,
      follow_up_ativo: true,
      follow_up_ultimo_motivo: motivo,
    };

    await leadMemory.updateLead(leadId, updates);
    console.log(`[followUpManager] Sequencia ${motivo} iniciada para ${leadId} (${formatLeadName(lead.nome)})`);
    return { ...lead, ...updates };
  }

  async iniciarSequenciaNoShow(leadId, options = {}) {
    const firstRunAt = options.firstRunAt instanceof Date
      ? options.firstRunAt
      : addDelay(new Date(), 2 * HOUR_MS);

    return this.iniciarSequencia(leadId, 'no_show', { ...options, firstRunAt });
  }

  async scheduleFollowUp(leadId, days = 3, reason = 'sem_resposta') {
    const motivo = reason === 'primeiro_contato' ? 'sem_resposta' : reason;
    const firstRunAt = addDelay(new Date(), Math.max(0, Number(days || 0)) * DAY_MS);
    return this.iniciarSequencia(leadId, motivo, { firstRunAt });
  }

  async cancelarSequencia(leadId, reason = 'lead_respondeu') {
    const lead = await leadMemory.getOrCreateLead(leadId);
    if (!lead.follow_up_sequencia && !lead.follow_up_proximo) {
      return lead;
    }

    const updates = {
      follow_up_sequencia: null,
      follow_up_step: 0,
      follow_up_proximo: null,
      follow_up_ativo: false,
      follow_up_cancelado_em: new Date().toISOString(),
      follow_up_ultimo_motivo: reason,
    };

    await leadMemory.updateLead(leadId, updates);
    return { ...lead, ...updates };
  }

  async registrarInteracao(leadId, userMessage, lead = null) {
    const currentLead = lead || await leadMemory.getOrCreateLead(leadId);
    const motivo = this.detectarMotivoPorMensagem(userMessage);

    if (currentLead.follow_up_sequencia || currentLead.follow_up_proximo) {
      await this.cancelarSequencia(leadId);
    }

    if (motivo) {
      await this.iniciarSequencia(leadId, motivo);
    }

    return motivo;
  }

  async _processarFollowUpsPendentes() {
    const now = new Date();
    const leads = this._getPendingLeads(now);

    if (leads.length > 0) {
      console.log(`[followUpManager] ${leads.length} lead(s) com follow-up pendente`);
    }

    for (const lead of leads) {
      try {
        await this._processarLead(lead, now);
      } catch (error) {
        console.error(`[followUpManager] Erro no lead ${lead.lead_id || lead.telefone}: ${error.message}`);
      }
    }
  }

  _getPendingLeads(now = new Date()) {
    const allLeads = Object.values(db.getAll('leads') || {});

    return allLeads
      .filter((lead) => {
        if (!lead || !lead.follow_up_sequencia) return false;
        if (ETAPAS_FINAIS.has(lead.etapa_funil)) return false;

        const dueAt = lead.follow_up_proximo || lead.proximo_follow_up;
        if (!dueAt) return false;

        return new Date(dueAt) <= now;
      })
      .sort((left, right) => new Date(left.follow_up_proximo).getTime() - new Date(right.follow_up_proximo).getTime());
  }

  async _processarLead(lead, now = new Date()) {
    const sequencia = lead.follow_up_sequencia;
    const step = (Number(lead.follow_up_step) || 0) + 1;
    const handler = this.sequencias[sequencia];

    if (!handler) {
      await this.cancelarSequencia(lead.lead_id || lead.telefone, 'sequencia_desconhecida');
      return;
    }

    const context = {
      lead,
      leadId: lead.lead_id || lead.telefone,
      step,
      nome: formatLeadName(lead.nome),
      interesse: getInterestLabel(lead),
      conteudoEducativo: getEducationalContent(lead),
      now,
    };

    const resultado = await handler(context);
    if (!resultado) return;

    if (resultado.mensagem) {
      await this.messaging.sendMessage(context.leadId, resultado.mensagem);
      await leadMemory.saveContext(context.leadId, resultado.mensagem, false);
    }

    if (resultado.encerrar) {
      const remarketingProximo = resultado.remarketingDelayMs
        ? addDelay(now, resultado.remarketingDelayMs).toISOString()
        : null;

      await leadMemory.updateLead(context.leadId, {
        etapa_funil: resultado.novoStatus || 'inativo',
        follow_up_sequencia: null,
        follow_up_step: step,
        follow_up_proximo: null,
        follow_up_ativo: false,
        follow_up_ultimo_envio_em: resultado.mensagem ? now.toISOString() : lead.follow_up_ultimo_envio_em || null,
        follow_up_encerrado_em: now.toISOString(),
        remarketing_proximo: remarketingProximo,
      });
      return;
    }

    const nextRunAt = addDelay(now, resultado.nextDelayMs || DAY_MS).toISOString();
    await leadMemory.updateLead(context.leadId, {
      follow_up_step: step,
      follow_up_count: step,
      follow_up_proximo: nextRunAt,
      follow_up_ativo: true,
      follow_up_ultimo_envio_em: resultado.mensagem ? now.toISOString() : lead.follow_up_ultimo_envio_em || null,
      follow_up_ultimo_motivo: sequencia,
    });
  }

  _getFirstRunDate(motivo, now = new Date()) {
    switch (motivo) {
      case 'considerando':
        return addDelay(now, DAY_MS);
      case 'recusou':
        return addDelay(now, 30 * DAY_MS);
      case 'no_show':
        return addDelay(now, 2 * HOUR_MS);
      case 'sem_resposta':
      default:
        return addDelay(now, 2 * DAY_MS);
    }
  }

  async _sequenciaSemResposta({ nome, interesse, step }) {
    if (step === 1) {
      return {
        mensagem: `Oi ${nome}! Tudo bem? Vi que nossa conversa ficou por aqui. Se ainda tiver pensando no assunto, estou aqui pra ajudar. 😊`,
        nextDelayMs: 3 * DAY_MS,
      };
    }

    if (step === 2) {
      return {
        mensagem: `Opa, ${nome}! So passando para deixar um recado: a gente atende muitos casos de ${interesse} por aqui. Se quiser saber como funciona antes de qualquer decisao, e so perguntar!`,
        nextDelayMs: 5 * DAY_MS,
      };
    }

    if (step === 3) {
      return {
        mensagem: `${nome}, nao quero te encher de mensagem, entao essa vai ser minha ultima por enquanto. Se em algum momento quiser retomar, me da um oi. Estarei aqui. 🙂`,
        nextDelayMs: 10 * DAY_MS,
      };
    }

    return {
      encerrar: true,
      novoStatus: 'inativo',
      remarketingDelayMs: 30 * DAY_MS,
    };
  }

  async _sequenciaConsiderando({ nome, interesse, conteudoEducativo, step }) {
    if (step === 1) {
      return {
        mensagem: `Entendo, ${nome}! As vezes a gente precisa de um tempo pra pensar. Se tiver alguma duvida que posso responder agora, pode perguntar! 😊`,
        nextDelayMs: 2 * DAY_MS,
      };
    }

    if (step === 2) {
      return {
        mensagem: `Oi ${nome}! So para te avisar: muita gente que passa pelo mesmo problema que voce descreveu (${interesse}) costuma ter otimos resultados com uma primeira avaliacao. E uma consulta rapida e sem compromisso. Quer ver os horarios?`,
        nextDelayMs: 4 * DAY_MS,
      };
    }

    if (step === 3) {
      return {
        mensagem: `${nome}, separei uma informacao que pode ser util: ${conteudoEducativo} Se quiser conversar mais, estou aqui.`,
        nextDelayMs: 7 * DAY_MS,
      };
    }

    return {
      encerrar: true,
      novoStatus: 'inativo',
    };
  }

  async _sequenciaRecusou({ nome, step }) {
    if (step === 1) {
      return {
        mensagem: `Oi ${nome}! Passando apenas para dizer ola e avisar que, se em algum momento quiser retomar, estaremos aqui. Sem pressao! 😊`,
        nextDelayMs: 60 * DAY_MS,
      };
    }

    return {
      encerrar: true,
      novoStatus: 'remarketing_pendente',
      remarketingDelayMs: 0,
    };
  }

  async _sequenciaNoShow({ nome, step }) {
    if (step === 1) {
      return {
        mensagem: `Oi ${nome}! Tivemos um horario agendado hoje, mas nao te vi por aqui. Aconteceu alguma coisa? Sem problema, podemos remarcar! 📅`,
        nextDelayMs: DAY_MS,
      };
    }

    if (step === 2) {
      return {
        mensagem: `${nome}, se quiser remarcar sua avaliacao, e so me falar. Tenho horarios disponiveis essa semana. 😊`,
        nextDelayMs: 2 * DAY_MS,
      };
    }

    return {
      encerrar: true,
      novoStatus: 'inativo',
    };
  }
}

module.exports = new FollowUpManager();