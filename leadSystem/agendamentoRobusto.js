'use strict';

const { randomUUID } = require('crypto');

const db = require('../database');
const calendar = require('../calendar');
const clientMemory = require('../clientMemory');
const MessagingClient = require('../messagingClient');
const leadMemory = require('./leadMemory');
const { getConfiguredTimeZone } = require('../utils/timezone');

const messaging = new MessagingClient();

const APPOINTMENT_STATE_PREFIX = 'agendamento_robusto:';
const DEFAULT_CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || 'Quality Hair Studio';
const CONFIRMATION_WORDS = new Set(['sim', 's', 'confirmo', 'confirmar', 'ok', 'certo', 'perfeito', 'combinado']);

function normalizeMessage(message) {
  return String(message || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isAffirmative(message) {
  const normalized = normalizeMessage(message);
  return CONFIRMATION_WORDS.has(normalized);
}

function isMeaningfulName(name) {
  if (!name) return false;
  const trimmed = String(name).trim();
  return Boolean(trimmed) && !/^cliente$/i.test(trimmed);
}

function getKnownName(phone, fallbackName) {
  const memory = clientMemory.getClientMemory(phone);
  return [fallbackName, memory?.personal?.name, 'Cliente']
    .find((name) => isMeaningfulName(name)) || 'Cliente';
}

class AgendamentoRobusto {
  constructor() {
    this.timezone = getConfiguredTimeZone();
    this.reminderTimers = new Map();
  }

  getLeadState(lead = {}) {
    return lead.agendamento_robusto || {};
  }

  isSchedulingInProgress(lead = {}) {
    const state = this.getLeadState(lead);
    return ['aguardando_escolha', 'aguardando_confirmacao'].includes(state.stage)
      || ['agendado_aguardando_escolha', 'agendado_aguardando_confirmacao'].includes(lead.etapa_funil);
  }

  shouldStartFromQualification(lead = {}, phase = null) {
    const qualification = lead.qualificacao || {};
    if (this.isSchedulingInProgress(lead)) return false;
    if (lead.agendamento_uuid || this.getLeadState(lead).agendamento_uuid) return false;

    if (qualification.pronto_para_agendamento === true) {
      return true;
    }

    if (phase && phase !== 'phase_3_transition') {
      return false;
    }

    return ['qualificado', 'hot'].includes(qualification.nivel_qualificacao);
  }

  async buscarHorariosDisponiveis() {
    try {
      const slots = await calendar.getAvailableSlots({ count: 3, minHoursFromNow: 4, daysAhead: 21 });
      if (Array.isArray(slots) && slots.length >= 3) {
        return slots.slice(0, 3);
      }
    } catch (error) {
      console.error('[agendamentoRobusto] Erro ao buscar slots reais:', error.message);
    }

    const fallbackHours = [10, 14, 9];
    return fallbackHours.map((hour, index) => {
      const start = new Date();
      start.setDate(start.getDate() + index + 1);
      start.setHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);

      return {
        start: start.toISOString(),
        end: end.toISOString(),
        available: true,
      };
    });
  }

  formatarHorarios(slots = []) {
    const days = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

    return slots.slice(0, 3).map((slot, index) => {
      const start = new Date(slot.start || slot.timestamp || slot);
      const end = new Date(slot.end || (start.getTime() + 60 * 60 * 1000));
      const label = `📅 ${days[start.getDay()]}, ${String(start.getDate()).padStart(2, '0')}/${String(start.getMonth() + 1).padStart(2, '0')} às ${String(start.getHours()).padStart(2, '0')}h`;

      return {
        index: index + 1,
        label,
        timestamp: start.toISOString(),
        start: start.toISOString(),
        end: end.toISOString(),
        monthLabel: months[start.getMonth()],
      };
    });
  }

  buildSlotsMessage(formattedSlots) {
    return `Ótimo! Tenho esses horários disponíveis:\n\n${formattedSlots.map((slot) => `${slot.index}. ${slot.label}`).join('\n')}\n\nQual funciona melhor pra você?`;
  }

  buildOfferMessage() {
    return 'Pelo que você me contou, o próximo passo mais indicado é uma avaliação capilar para entender melhor o seu caso. É uma consulta rápida e sem compromisso. Quer que eu veja os horários disponíveis? 📅';
  }

  async updateClientSchedulingMemory(phone, patch = {}) {
    const memory = clientMemory.getClientMemory(phone);

    if (Object.prototype.hasOwnProperty.call(patch, 'pendingScheduling')) {
      memory.pendingScheduling = patch.pendingScheduling;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'activeScheduling')) {
      memory.activeScheduling = patch.activeScheduling;
    }

    memory.last_updated = new Date().toISOString();
    await clientMemory.saveMemories();
    return memory;
  }

  async persistLeadSchedulingState(phone, updates = {}) {
    const currentLead = await leadMemory.getOrCreateLead(phone);
    const currentState = currentLead.agendamento_robusto || {};
    const nextState = {
      ...currentState,
      ...(updates.agendamento_robusto || {}),
      updated_at: new Date().toISOString(),
    };

    const payload = {
      ...updates,
      agendamento_robusto: nextState,
    };

    await leadMemory.updateLead(phone, payload);
    return nextState;
  }

  async iniciarAgendamento(phone, nome, lead = null) {
    const currentLead = lead || await leadMemory.getOrCreateLead(phone, nome);
    const state = this.getLeadState(currentLead);

    if (state.stage === 'aguardando_escolha' && Array.isArray(state.slots_oferecidos) && state.slots_oferecidos.length === 3) {
      return {
        handled: true,
        success: true,
        message: this.buildSlotsMessage(state.slots_oferecidos),
        availableSlots: state.slots_oferecidos,
      };
    }

    const slots = await this.buscarHorariosDisponiveis();
    const formattedSlots = this.formatarHorarios(slots);
    const sentAt = new Date().toISOString();

    await this.persistLeadSchedulingState(phone, {
      etapa_funil: 'agendado_aguardando_escolha',
      slots_oferecidos: formattedSlots,
      slots_oferecidos_em: sentAt,
      slot_pendente_confirmacao: null,
      agendamento_robusto: {
        stage: 'aguardando_escolha',
        slots_oferecidos: formattedSlots,
        slots_oferecidos_em: sentAt,
        slot_pendente_confirmacao: null,
      },
    });

    await this.updateClientSchedulingMemory(phone, {
      pendingScheduling: {
        step: 'waiting_slot_selection',
        availableSlots: formattedSlots,
        lastRequestTime: sentAt,
      },
      activeScheduling: null,
    });

    return {
      handled: true,
      success: true,
      message: this.buildSlotsMessage(formattedSlots),
      availableSlots: formattedSlots,
    };
  }

  resolveSlotChoice(choice, slots = []) {
    const normalizedChoice = normalizeMessage(choice);
    const numericChoice = Number.parseInt(normalizedChoice, 10);

    if (numericChoice >= 1 && numericChoice <= slots.length) {
      return slots[numericChoice - 1];
    }

    return slots.find((slot) => {
      const label = normalizeMessage(slot.label);
      const dayToken = label.split(',')[0].replace('📅', '').trim();
      const hourToken = label.split('às')[1]?.trim() || '';
      return normalizedChoice.includes(dayToken) || normalizedChoice.includes(hourToken);
    }) || null;
  }

  async processarEscolha(phone, nome, escolha) {
    const lead = await leadMemory.getOrCreateLead(phone, nome);
    const state = this.getLeadState(lead);
    const slots = state.slots_oferecidos || lead.slots_oferecidos || [];

    if (!slots.length) {
      return {
        handled: true,
        success: false,
        message: 'Desculpa, precisamos reiniciar. Posso te mandar os horários novamente?',
      };
    }

    const selectedSlot = this.resolveSlotChoice(escolha, slots);
    if (!selectedSlot) {
      return {
        handled: true,
        success: false,
        message: 'Não entendi bem. Pode me dizer o número da opção? (1, 2 ou 3)',
      };
    }

    const pendingToken = `pending:${randomUUID()}`;

    await this.persistLeadSchedulingState(phone, {
      etapa_funil: 'agendado_aguardando_confirmacao',
      slot_pendente_confirmacao: selectedSlot,
      agendamento_robusto: {
        ...state,
        stage: 'aguardando_confirmacao',
        slot_pendente_confirmacao: selectedSlot,
        pending_token: pendingToken,
      },
    });

    await this.updateClientSchedulingMemory(phone, {
      pendingScheduling: {
        step: 'pending_confirmation',
        eventId: pendingToken,
        selectedDateTime: selectedSlot.timestamp,
        lastRequestTime: new Date().toISOString(),
      },
    });

    const resolvedName = getKnownName(phone, nome);
    return {
      handled: true,
      success: true,
      selectedSlot,
      message: `Perfeito! Confirmo: ${resolvedName}, você quer agendar para ${selectedSlot.label.replace('📅 ', '')}? ✅\n\nResponde com "sim" para confirmar ou me diz outro horário que prefira.`,
    };
  }

  async saveAppointmentRecord(record) {
    this.reminderTimers.set(record.uuid, this.reminderTimers.get(record.uuid) || {});
    db.set('conversation_states', `${APPOINTMENT_STATE_PREFIX}${record.uuid}`, record);

    try {
      await db.query(
        `INSERT INTO agendamentos_robusto
         (uuid, lead_id, data_agendamento, status_confirmacao, cliente_confirmou_em)
         VALUES ($1, $2, $3, $4, NOW())`,
        [record.uuid, record.lead_id, new Date(record.data_agendamento), record.status_confirmacao]
      );
    } catch (error) {
      console.warn(`[agendamentoRobusto] Persistência principal indisponível para ${record.uuid}: ${error.message}`);
    }
  }

  getAppointmentRecord(uuid) {
    return db.get('conversation_states', `${APPOINTMENT_STATE_PREFIX}${uuid}`) || null;
  }

  async updateAppointmentRecord(uuid, patch = {}) {
    const current = this.getAppointmentRecord(uuid) || { uuid };
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    db.set('conversation_states', `${APPOINTMENT_STATE_PREFIX}${uuid}`, next);

    try {
      const updates = [];
      const values = [];
      let index = 1;

      const map = {
        status_confirmacao: 'status_confirmacao',
        lembrete_24h_enviado: 'lembrete_24h_enviado',
        lembrete_2h_enviado: 'lembrete_2h_enviado',
        cliente_nao_apareceu: 'cliente_nao_apareceu',
      };

      for (const [field, column] of Object.entries(map)) {
        if (field in patch) {
          updates.push(`${column} = $${index++}`);
          values.push(patch[field]);
        }
      }

      if (updates.length > 0) {
        values.push(uuid);
        await db.query(`UPDATE agendamentos_robusto SET ${updates.join(', ')} WHERE uuid = $${index}`, values);
      }
    } catch (error) {
      console.warn(`[agendamentoRobusto] Atualização de lembrete indisponível para ${uuid}: ${error.message}`);
    }

    return next;
  }

  async confirmarAgendamento(phone, nome) {
    const lead = await leadMemory.getOrCreateLead(phone, nome);
    const state = this.getLeadState(lead);
    const pendingSlot = state.slot_pendente_confirmacao || lead.slot_pendente_confirmacao;

    if (!pendingSlot) {
      return {
        handled: true,
        success: false,
        message: 'Parece que não temos um horário selecionado. Posso oferecer opções novamente?',
      };
    }

    const start = new Date(pendingSlot.timestamp || pendingSlot.start);
    const end = new Date(pendingSlot.end || (start.getTime() + 60 * 60 * 1000));
    const availability = await calendar.checkAvailability(start.toISOString().slice(0, 10), start.toISOString().slice(11, 16), 60, end.toISOString().slice(11, 16));

    if (availability?.error || availability?.available === false) {
      const refreshed = await this.iniciarAgendamento(phone, nome, lead);
      return {
        handled: true,
        success: false,
        message: `Esse horário acabou de deixar de ficar disponível. Posso te oferecer estas novas opções:\n\n${refreshed.message}`,
      };
    }

    const resolvedName = getKnownName(phone, nome);
    const eventResult = await calendar.scheduleConsultation(resolvedName, start.toISOString(), end.toISOString());
    if (!eventResult.success) {
      return {
        handled: true,
        success: false,
        message: 'Desculpa, houve um problema ao confirmar o agendamento. Posso te mostrar os horários novamente?',
      };
    }

    const uuid = randomUUID();
    const linkReuniao = eventResult.link || null;

    await this.saveAppointmentRecord({
      uuid,
      lead_id: phone,
      event_id: eventResult.eventId,
      data_agendamento: start.toISOString(),
      status_confirmacao: 'confirmado',
      link_reuniao: linkReuniao,
      slot_label: pendingSlot.label,
      lembrete_24h_enviado: false,
      lembrete_2h_enviado: false,
      cliente_nao_apareceu: false,
    });

    clientMemory.recordAppointment(phone, {
      eventId: eventResult.eventId,
      dateTime: start.toISOString(),
      source: 'sofia-agendamento-robusto',
      status: 'confirmed',
      link: linkReuniao,
      robust_uuid: uuid,
    });

    await this.updateClientSchedulingMemory(phone, {
      pendingScheduling: null,
      activeScheduling: {
        eventId: eventResult.eventId,
        selectedDateTime: start.toISOString(),
        step: 'confirmed',
      },
    });

    await this.persistLeadSchedulingState(phone, {
      etapa_funil: 'agendado',
      agendado_em: new Date().toISOString(),
      agendamento_uuid: uuid,
      slots_oferecidos: null,
      slot_pendente_confirmacao: null,
      status_agendamento: 'confirmado',
      data_agendamento: start.toISOString(),
      hora_agendada: start.toISOString(),
      agendamento_robusto: {
        stage: 'confirmado',
        agendamento_uuid: uuid,
        event_id: eventResult.eventId,
        link_reuniao: linkReuniao,
        slot_confirmado: pendingSlot,
        slots_oferecidos: [],
        slot_pendente_confirmacao: null,
      },
    });

    const confirmationMessage = this._mensagemConfirmacao(resolvedName, pendingSlot.label, linkReuniao);
    await this._agendarLembretes(uuid, phone, start.toISOString(), linkReuniao);

    return {
      handled: true,
      success: true,
      uuid,
      dataAgendamento: start.toISOString(),
      linkReuniao,
      message: confirmationMessage,
    };
  }

  _mensagemConfirmacao(nome, label, link) {
    return `✅ Agendamento confirmado!\n\n${label}\n${link ? `🔗 Link: ${link}\n` : `📍 ${DEFAULT_CLINIC_ADDRESS}\n`}\nVocê receberá um lembrete:\n⏰ 24h antes\n⏰ 2h antes\n\nQualquer dúvida, é só me chamar aqui! 😊`;
  }

  async _sendReminderMessage(phone, message) {
    try {
      await messaging.sendMessage(phone, message);
    } catch (error) {
      console.warn(`[agendamentoRobusto] Falha ao enviar lembrete para ${phone}: ${error.message}`);
    }
  }

  async _agendarLembretes(uuid, phone, dataAgendamento, linkReuniao) {
    const now = Date.now();
    const appointmentTime = new Date(dataAgendamento).getTime();
    const timers = {};

    const scheduleTimer = (field, targetTime, action) => {
      if (targetTime <= now) return;
      timers[field] = setTimeout(action, targetTime - now);
    };

    scheduleTimer('reminder24h', appointmentTime - 24 * 60 * 60 * 1000, async () => {
      await this._enviarLembrete24h(uuid, phone, linkReuniao);
    });

    scheduleTimer('reminder2h', appointmentTime - 2 * 60 * 60 * 1000, async () => {
      await this._enviarLembrete2h(uuid, phone, linkReuniao);
    });

    scheduleTimer('noShow', appointmentTime + 30 * 60 * 1000, async () => {
      await this._verificarNoShow(uuid, phone);
    });

    this.reminderTimers.set(uuid, timers);
    console.log(`[agendamentoRobusto] Lembretes agendados para ${phone} (${uuid})`);
  }

  async _enviarLembrete24h(uuid, phone, linkReuniao) {
    const record = this.getAppointmentRecord(uuid);
    if (!record || record.lembrete_24h_enviado) return;

    const message = `⏰ Lembrete! Sua avaliação capilar é amanhã.\n${linkReuniao ? `Link: ${linkReuniao}\n\n` : '\n'}Confirma presença? ✓`;
    await this._sendReminderMessage(phone, message);
    await this.updateAppointmentRecord(uuid, { lembrete_24h_enviado: true });
  }

  async _enviarLembrete2h(uuid, phone, linkReuniao) {
    const record = this.getAppointmentRecord(uuid);
    if (!record || record.lembrete_2h_enviado) return;

    const message = `🔔 Sua avaliação começa em 2 horas!\n${linkReuniao ? `Link: ${linkReuniao}` : 'Te esperamos!'}`;
    await this._sendReminderMessage(phone, message);
    await this.updateAppointmentRecord(uuid, { lembrete_2h_enviado: true });
  }

  async _verificarNoShow(uuid, phone) {
    const record = this.getAppointmentRecord(uuid);
    if (!record || record.cliente_nao_apareceu || record.status_confirmacao !== 'confirmado') return;

    await this.updateAppointmentRecord(uuid, { cliente_nao_apareceu: true });

    try {
      const followUpManager = require('./followUpManager');
      if (typeof followUpManager.iniciarSequenciaNoShow === 'function') {
        await followUpManager.iniciarSequenciaNoShow(phone);
      } else {
        console.log(`[agendamentoRobusto] No-show registrado para ${phone}; sequência ficará para o passo 04`);
      }
    } catch (error) {
      console.warn(`[agendamentoRobusto] Falha ao tratar no-show de ${phone}: ${error.message}`);
    }
  }

  async handleSchedulingMessage(phone, nome, lead, userMessage, intentionType) {
    const state = this.getLeadState(lead);
    const stage = state.stage;

    if (stage === 'aguardando_escolha' || lead.etapa_funil === 'agendado_aguardando_escolha') {
      return this.processarEscolha(phone, nome, userMessage);
    }

    if (stage === 'aguardando_confirmacao' || lead.etapa_funil === 'agendado_aguardando_confirmacao' || intentionType === 'schedule_confirmation') {
      if (isAffirmative(userMessage)) {
        return this.confirmarAgendamento(phone, nome);
      }

      return {
        handled: true,
        success: false,
        message: 'Se quiser confirmar, me responde com "sim". Se preferir outro horário, me diga o número da nova opção e eu ajusto para você.',
      };
    }

    if (intentionType === 'scheduling') {
      return this.iniciarAgendamento(phone, nome, lead);
    }

    return { handled: false };
  }
}

module.exports = new AgendamentoRobusto();