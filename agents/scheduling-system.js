'use strict';

const { OpenAI } = require('openai');
const calendar = require('../calendar');
const leadMemory = require('../leadSystem/leadMemory');
const clientMemory = require('../clientMemory');
const messageQueue = require('../messageQueue');
const cron = require('node-cron');
const { formatDateOnlyInTimeZone, getConfiguredTimeZone } = require('../utils/timezone');

let schedulingOpenAIClient = null;

const BUSINESS_CONFIG = {
  timezone: getConfiguredTimeZone(),
  openTime: '08:00',
  closeTime: '18:00',
  slotDuration: 60,
  minSlots: 3,
  daysAhead: 15,
  excludeDays: [0, 6],
  bufferMinutes: 30,
};

const MESSAGE_TEMPLATES = {
  askDateTime: (name) => `Ótimo, ${name}! 😊

Para agendar sua avaliação capilar, me diga primeiro:

1️⃣ Qual dia você prefere? (ex.: amanhã, quinta, próxima semana)

Depois eu vejo os horários reais desse dia para você. 📅`,

  askPreferredDay: (name) => `Perfeito, ${name || 'tudo bem'}! 📅

Qual dia você prefere para a sua avaliação capilar?

Pode me responder algo como: *amanhã*, *quinta-feira* ou *próxima semana*.`,

  showAvailable: (slots) => {
    if (!slots || slots.length === 0) {
      return 'Não encontrei horários livres nessa opção agora. Se quiser, me diga outro dia de preferência que eu verifico para você.';
    }

    const formatNatural = (slot) => {
      const date = new Date(slot.start);
      return date.toLocaleString('pt-BR', {
        weekday: 'long',
        day: '2-digit',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });
    };

    if (slots.length === 2) {
      return `Encontrei dois horários disponíveis! 📅\n\n*${formatNatural(slots[0])}* ou *${formatNatural(slots[1])}*\n\nQual prefere? 😊`;
    }

    if (slots.length === 1) {
      return `Encontrei este horário disponível! 📅\n\n*${formatNatural(slots[0])}*\n\nSe quiser, posso verificar outro dia também. 😊`;
    }

    const opcoes = slots.slice(0, 3).map((slot) => `• *${formatNatural(slot)}*`).join('\n');
    return `Encontrei esses horários disponíveis para você! 📅\n\n${opcoes}\n\nQual combina melhor? Pode me dizer o dia ou a hora que preferir 😊`;
  },

  confirmSchedule: (name, dateTime) => {
    const date = new Date(dateTime);
    const formatted = date.toLocaleString('pt-BR', {
      timeZone: BUSINESS_CONFIG.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    return `✅ *Agendamento Confirmado!*\n\n👤 *Cliente:* ${name}\n📅 *Data/Hora:* ${formatted}\n📍 *Local:* Quality Hair Studio\n\nVocê receberá um lembrete 24h antes! 🔔\n\nAlgo mais que posso ajudá-lo?`;
  },

  reminder: (name, dateTime) => {
    const date = new Date(dateTime);
    const formatted = date.toLocaleString('pt-BR', {
      timeZone: BUSINESS_CONFIG.timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });

    return `🔔 *LEMBRETE DE AGENDAMENTO*\n\nOlá ${name}! 👋\n\nNão esqueça da sua avaliação capilar amanhã às ${formatted}!\n\nConfirme sua presença respondendo com: *Confirmo* ✅\n\nPrecisa reagendar? Responda: *Cancelar* ou *Remarcar*`;
  },

  cancellationConfirm: (name) => `Entendo, ${name}! 😊\n\nSeu agendamento foi cancelado com sucesso. ✅\n\nVocê pode reagendar a qualquer momento. Basta me chamar novamente! 📅\n\nAlgo mais em que possa ajudá-lo?`,

  rescheduling: (name) => `Claro, ${name}! Sem problema! 😊\n\nVou buscar horários disponíveis novamente...\n\nQue dia/hora combina melhor com você agora?`,

  askOtherPreferredDay: 'Não encontrei horários livres nesse dia. Qual outro dia você prefere? Posso verificar para você.',

  askOtherTimePreference: (slots) => `Tenho estas outras opções para você:\n\n${MESSAGE_TEMPLATES.showAvailable(slots)}`,

  needConfirmation: (name, dateTime) => {
    const date = new Date(dateTime);
    const formatted = date.toLocaleString('pt-BR', {
      timeZone: BUSINESS_CONFIG.timezone,
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });

    return `Perfeito, ${name}! 🎉\n\nReservei *${formatted}* para você.\n\nConfirmo o agendamento? 😊`;
  },
};

function normalizeMessage(message) {
  return String(message || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getPendingSchedulingTtlMs(step) {
  if (step === 'pending_confirmation') {
    return 24 * 60 * 60 * 1000;
  }

  return 6 * 60 * 60 * 1000;
}

function getClientContext(phone) {
  return clientMemory.getClientMemory(phone) || {};
}

function normalizeSchedulingContext(phone, memory = getClientContext(phone)) {
  const pendingScheduling = memory?.pendingScheduling;
  if (!pendingScheduling?.step) {
    return memory;
  }

  const reasons = [];
  const lastRequestAt = Date.parse(
    pendingScheduling.lastRequestTime || pendingScheduling.updatedAt || pendingScheduling.createdAt || '',
  );

  if (
    pendingScheduling.step === 'waiting_slot_selection' &&
    (!Array.isArray(pendingScheduling.availableSlots) || pendingScheduling.availableSlots.length === 0)
  ) {
    reasons.push('empty_available_slots');
  }

  if (pendingScheduling.step === 'waiting_full_name' && !pendingScheduling.requestedSlot) {
    reasons.push('missing_requested_slot');
  }

  if (pendingScheduling.step === 'pending_confirmation' && !pendingScheduling.eventId) {
    reasons.push('missing_event_id');
  }

  if (Number.isFinite(lastRequestAt) && (Date.now() - lastRequestAt) > getPendingSchedulingTtlMs(pendingScheduling.step)) {
    reasons.push('expired');
  }

  if (reasons.length === 0) {
    return memory;
  }

  memory.pendingScheduling = null;
  memory.last_updated = new Date().toISOString();
  const saveAttempt = clientMemory.saveMemories();
  if (saveAttempt?.catch) {
    saveAttempt.catch((error) => {
      console.warn(`⚠️ [SchedulingContext] Falha ao limpar contexto de ${phone}: ${error.message}`);
    });
  }

  console.log(`🧹 [SchedulingContext] Contexto de agendamento limpo para ${phone}: ${reasons.join(', ')}`);
  return memory;
}

function wantsAlternativeSlots(message) {
  const msg = normalizeMessage(message);
  return [
    'outro horario', 'outros horarios', 'outro horario?', 'tem outro horario',
    'tem outros horarios', 'mais tarde', 'mais cedo', 'outra opcao', 'outras opcoes',
  ].some((term) => msg.includes(term));
}

function isMeaningfulName(name) {
  if (!name) return false;
  const trimmed = String(name).trim();
  if (!trimmed || /^cliente$/i.test(trimmed)) return false;
  if (/^\+?\d+$/.test(trimmed.replace(/[\s()-]/g, ''))) return false;
  return /[a-zA-ZÀ-ÿ]/.test(trimmed);
}

function normalizePersonName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function extractProvidedName(message, allowFreeform = false) {
  const raw = String(message || '').trim();
  const explicitPatterns = [
    /meu nome(?: completo)? é\s+([A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+)/i,
    /sou\s+([A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+)/i,
    /aqui é\s+([A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+)/i,
    /pode colocar no nome de\s+([A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      return normalizePersonName(match[1]);
    }
  }

  if (allowFreeform && /^[A-Za-zÀ-ÿ'´`.-]+(?:\s+[A-Za-zÀ-ÿ'´`.-]+)+$/.test(raw)) {
    return normalizePersonName(raw);
  }

  return null;
}

async function persistLeadName(phone, providedName) {
  if (!isMeaningfulName(providedName)) {
    return null;
  }

  const normalizedName = normalizePersonName(providedName);
  clientMemory.updatePersonalInfo(phone, 'name', normalizedName);
  await leadMemory.updateLead(phone, { nome: normalizedName });
  return normalizedName;
}

function resolveKnownName(phone, providedName, fallbackName) {
  if (isMeaningfulName(providedName)) {
    return normalizePersonName(providedName);
  }

  const memoryName = clientMemory.getClientMemory(phone)?.personal?.name;
  if (isMeaningfulName(memoryName)) {
    return normalizePersonName(memoryName);
  }

  if (isMeaningfulName(fallbackName)) {
    return normalizePersonName(fallbackName);
  }

  return null;
}

async function saveClientContext(phone, updates) {
  const memory = clientMemory.getClientMemory(phone);
  Object.assign(memory, updates, { last_updated: new Date().toISOString() });
  await clientMemory.saveMemories();
  return memory;
}

function getActiveScheduling(memory, pendingScheduling) {
  if (pendingScheduling?.eventId) {
    return pendingScheduling;
  }

  if (memory?.activeScheduling?.eventId) {
    return memory.activeScheduling;
  }

  const scheduled = memory?.appointments?.scheduled || [];
  for (let index = scheduled.length - 1; index >= 0; index -= 1) {
    const appointment = scheduled[index];
    if (appointment?.eventId && appointment.status !== 'cancelled') {
      return {
        eventId: appointment.eventId,
        selectedDateTime: appointment.dateTime,
        step: 'confirmed',
      };
    }
  }

  return null;
}

class SchedulingIntentionAnalyzer {
  static getOpenAIClient() {
    if (schedulingOpenAIClient) return schedulingOpenAIClient;
    if (!process.env.OPENAI_API_KEY) return null;

    schedulingOpenAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return schedulingOpenAIClient;
  }

  static analyzeMessage(message) {
    const msg = normalizeMessage(message);

    const schedulingKeywords = [
      'agendar', 'marcar', 'agenda', 'marca', 'horario', 'hora', 'quando', 'qual dia',
      'disponivel', 'disponibilidade', 'consulta', 'avaliacao', 'sessao',
      'gostaria de', 'gostaria', 'queria', 'quero agendar',
    ];

    const cancellationKeywords = [
      'cancelar', 'cancelo', 'nao vou', 'desmarcar', 'desmarca', 'tirar',
      'nao posso', 'nao consegui', 'impossivel', 'desistir', 'desisto',
    ];

    const reschedulingKeywords = [
      'remarcar', 'reagendar', 'agendar outro', 'mudar horario', 'trocar horario',
      'outro dia', 'outro horario',
    ];

    const confirmationKeywords = [
      'confirmar', 'confirmacao', 'confirmo', 'confirma', 'confirmado', 'aceito', 'ok', 'sim',
      'perfeito', 'pode ser', 'combinado', 'certo',
    ];

    const typeMap = [
      { keywords: cancellationKeywords, type: 'cancellation' },
      { keywords: reschedulingKeywords, type: 'rescheduling' },
      { keywords: confirmationKeywords, type: 'confirmation' },
      { keywords: schedulingKeywords, type: 'scheduling' },
    ];

    let maxMatches = 0;
    let detectedType = null;

    for (const { keywords, type } of typeMap) {
      const matches = keywords.filter((kw) => msg.includes(kw)).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedType = type;
      }
    }

    const hasIntent = maxMatches > 0;
    return {
      hasIntent,
      type: detectedType,
      confidence: hasIntent ? Math.min(maxMatches * 20, 100) : 0,
      matches: maxMatches,
    };
  }

  static async analyzeMessageWithAI(message, context = {}) {
    const openai = this.getOpenAIClient();
    if (!openai) {
      return this.analyzeMessage(message);
    }

    const payload = {
      latestUserMessage: message,
      pendingScheduling: context.pendingScheduling || null,
      activeScheduling: context.activeScheduling || null,
      hasAvailableSlots: Boolean(context.pendingScheduling?.availableSlots?.length),
      knownName: context.knownName || null,
    };

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_ROUTER_MODEL || 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Você classifica a intenção operacional de uma mensagem dentro do fluxo de agendamento de uma clínica.',
              'Tipos válidos: scheduling, confirmation, cancellation, rescheduling, none.',
              'Use none para saudações, mensagens genéricas ou conversas que não peçam ação de agenda.',
              'Considere fortemente o contexto pendingScheduling e activeScheduling.',
              'Se existir pendingScheduling.step=pending_confirmation e a mensagem aprovar a reserva, retorne confirmation.',
              'Se a mensagem quiser cancelar uma reserva existente, retorne cancellation.',
              'Se quiser trocar dia/horário de uma reserva existente, retorne rescheduling.',
              'Se a mensagem quiser iniciar agendamento, escolher horário, informar dia preferido, ou fornecer dados necessários para concluir o agendamento, retorne scheduling.',
              'Não use uma lista fixa de palavras como regra principal; decida pelo significado da mensagem e pelo contexto.',
              'Responda apenas JSON com: type, hasIntent, confidence, reason.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify(payload),
          },
        ],
      });

      const content = completion.choices?.[0]?.message?.content;
      const parsed = JSON.parse(content || '{}');
      const validTypes = new Set(['scheduling', 'confirmation', 'cancellation', 'rescheduling', 'none']);
      if (!validTypes.has(parsed.type)) {
        return this.analyzeMessage(message);
      }

      return {
        hasIntent: parsed.type !== 'none',
        type: parsed.type === 'none' ? null : parsed.type,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        reason: parsed.reason || null,
        source: 'openai',
      };
    } catch (error) {
      console.warn(`⚠️ [SchedulingIntentionAnalyzer] Fallback local: ${error.message}`);
      return this.analyzeMessage(message);
    }
  }

  static extractDateTime(message) {
    const msg = normalizeMessage(message);
    const timePattern = /(\d{1,2})(?::([0-5]\d))?\s*(h|horas?)?/;
    const timeMatch = msg.match(timePattern);

    let suggestedTime = null;
    if (timeMatch) {
      const hour = Number(timeMatch[1]);
      const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      if (hour >= 8 && hour <= 18) {
        suggestedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      }
    }

    const dayPatterns = {
      'segunda': 1,
      'segunda-feira': 1,
      'terca': 2,
      'terca-feira': 2,
      'terça': 2,
      'terça-feira': 2,
      'quarta': 3,
      'quarta-feira': 3,
      'quinta': 4,
      'quinta-feira': 4,
      'sexta': 5,
      'sexta-feira': 5,
      'amanha': 1,
      'semana que vem': 7,
      'proxima semana': 7,
      'próxima semana': 7,
    };

    let suggestedDate = null;
    for (const [pattern, offset] of Object.entries(dayPatterns)) {
      if (msg.includes(pattern)) {
        const date = new Date();
        if (pattern === 'amanha') {
          date.setDate(date.getDate() + 1);
        } else if (offset === 7) {
          date.setDate(date.getDate() + 7);
        } else {
          const currentDay = date.getDay();
          let delta = offset - currentDay;
          if (delta <= 0) delta += 7;
          date.setDate(date.getDate() + delta);
        }
        suggestedDate = formatDateOnlyInTimeZone(date, BUSINESS_CONFIG.timezone);
        break;
      }
    }

    return {
      suggestedDate,
      suggestedTime,
      confidence: (suggestedDate ? 50 : 0) + (suggestedTime ? 50 : 0),
    };
  }
}

class BusinessHoursManager {
  static isBusinessHour(date) {
    const localDate = new Date(date);
    const day = localDate.getDay();
    if (BUSINESS_CONFIG.excludeDays.includes(day)) return false;

    const [openHour, openMin] = BUSINESS_CONFIG.openTime.split(':').map(Number);
    const [closeHour, closeMin] = BUSINESS_CONFIG.closeTime.split(':').map(Number);
    const dateMinutes = localDate.getHours() * 60 + localDate.getMinutes();
    const openMinutes = openHour * 60 + openMin;
    const closeMinutes = closeHour * 60 + closeMin;

    return dateMinutes >= openMinutes && dateMinutes < closeMinutes;
  }

  static formatSlot(date) {
    return date.toLocaleString('pt-BR', {
      timeZone: BUSINESS_CONFIG.timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  static async getAvailableSlots(count = BUSINESS_CONFIG.minSlots) {
    const slots = [];
    const cursor = new Date();
    const [openHour] = BUSINESS_CONFIG.openTime.split(':').map(Number);
    const [closeHour, closeMinute] = BUSINESS_CONFIG.closeTime.split(':').map(Number);
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + BUSINESS_CONFIG.daysAhead);

    if (cursor.getHours() < openHour) {
      cursor.setHours(openHour, 0, 0, 0);
    } else {
      const minutes = cursor.getMinutes();
      const roundedMinutes = minutes === 0 ? 0 : Math.ceil(minutes / 30) * 30;
      cursor.setMinutes(roundedMinutes, 0, 0);
      if (roundedMinutes >= 60) {
        cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      }
    }

    if (cursor.getHours() > closeHour || (cursor.getHours() === closeHour && cursor.getMinutes() >= closeMinute)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(openHour, 0, 0, 0);
    }

    while (slots.length < count && cursor <= deadline) {
      if (BUSINESS_CONFIG.excludeDays.includes(cursor.getDay())) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(openHour, 0, 0, 0);
        continue;
      }

      if (!this.isBusinessHour(cursor)) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(openHour, 0, 0, 0);
        continue;
      }

      const nextSlot = new Date(cursor.getTime() + BUSINESS_CONFIG.slotDuration * 60000);
      const isAvailable = await calendar.isTimeAvailable(cursor, nextSlot);

      if (isAvailable) {
        slots.push({
          start: cursor.toISOString(),
          end: nextSlot.toISOString(),
          label: this.formatSlot(cursor),
        });
      }

      cursor.setMinutes(cursor.getMinutes() + BUSINESS_CONFIG.slotDuration + BUSINESS_CONFIG.bufferMinutes);

      const [closeHour] = BUSINESS_CONFIG.closeTime.split(':').map(Number);
      if (cursor.getHours() >= closeHour) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(openHour, 0, 0, 0);
      }
    }

    return slots;
  }

  static async getAvailableSlotsForDate(dateString, count = 2, offset = 0) {
    if (!dateString) return [];

    const slots = [];
    const [year, month, day] = dateString.split('-').map(Number);
    const cursor = new Date(year, month - 1, day);
    const [openHour, openMinute] = BUSINESS_CONFIG.openTime.split(':').map(Number);
    const [closeHour, closeMinute] = BUSINESS_CONFIG.closeTime.split(':').map(Number);

    cursor.setHours(openHour, openMinute, 0, 0);

    if (BUSINESS_CONFIG.excludeDays.includes(cursor.getDay())) {
      return [];
    }

    const daySlots = [];
    while (cursor.getHours() < closeHour || (cursor.getHours() === closeHour && cursor.getMinutes() < closeMinute)) {
      const start = new Date(cursor);
      const end = new Date(start.getTime() + BUSINESS_CONFIG.slotDuration * 60000);

      if (!this.isBusinessHour(start) || end.getHours() > closeHour || (end.getHours() === closeHour && end.getMinutes() > closeMinute)) {
        cursor.setMinutes(cursor.getMinutes() + BUSINESS_CONFIG.slotDuration + BUSINESS_CONFIG.bufferMinutes);
        continue;
      }

      const isAvailable = await calendar.isTimeAvailable(start, end);
      if (isAvailable) {
        daySlots.push({
          start: start.toISOString(),
          end: end.toISOString(),
          label: this.formatSlot(start),
        });
      }

      cursor.setMinutes(cursor.getMinutes() + BUSINESS_CONFIG.slotDuration + BUSINESS_CONFIG.bufferMinutes);
    }

    return daySlots.slice(offset, offset + count);
  }

  static async findRequestedSlot(suggestedDate, suggestedTime) {
    if (!suggestedDate || !suggestedTime) {
      return null;
    }

    const candidateStart = new Date(`${suggestedDate}T${suggestedTime}:00`);
    if (!this.isBusinessHour(candidateStart)) {
      return null;
    }

    const candidateEnd = new Date(candidateStart.getTime() + BUSINESS_CONFIG.slotDuration * 60000);
    const isAvailable = await calendar.isTimeAvailable(candidateStart, candidateEnd);
    if (!isAvailable) {
      return null;
    }

    return {
      start: candidateStart.toISOString(),
      end: candidateEnd.toISOString(),
      label: this.formatSlot(candidateStart),
    };
  }
}

class NaturalSlotParser {
  static parse(message, slots) {
    if (!slots || slots.length === 0) return null;
    const msg = normalizeMessage(message);
    const hasTerm = (term) => new RegExp(`(^|\\s)${term}(\\s|$)`).test(msg);

    const ordinals = [
      ['primeiro', 'primeira', '1o', '1a', 'um', 'uma', '1'],
      ['segundo', 'segunda', '2o', '2a', 'dois', 'duas', '2'],
      ['terceiro', 'terceira', '3o', '3a', 'tres', '3'],
      ['ultimo', 'ultima', 'por ultimo'],
    ];

    for (let i = 0; i < ordinals.length; i += 1) {
      const idx = i === ordinals.length - 1 ? slots.length - 1 : i;
      if (ordinals[i].some((term) => hasTerm(term)) && idx < slots.length) {
        return idx;
      }
    }

    const timeRegex = /(\d{1,2})(?:h|:)(\d{0,2})?/g;
    let timeMatch = timeRegex.exec(msg);
    while (timeMatch !== null) {
      const hour = Number(timeMatch[1]);
      const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      const matchIndex = slots.findIndex((slot) => {
        const slotDate = new Date(slot.start);
        return slotDate.getHours() === hour && (!timeMatch[2] || slotDate.getMinutes() === minute);
      });
      if (matchIndex !== -1) return matchIndex;
      timeMatch = timeRegex.exec(msg);
    }

    const weekdays = {
      'segunda': 1,
      'terca': 2,
      'terça': 2,
      'quarta': 3,
      'quinta': 4,
      'sexta': 5,
      'sabado': 6,
      'domingo': 0,
      'amanha': null,
    };

    for (const [term, dayNum] of Object.entries(weekdays)) {
      if (!msg.includes(term)) continue;
      if (term === 'amanha') {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const idx = slots.findIndex((slot) => new Date(slot.start).toDateString() === tomorrow.toDateString());
        if (idx !== -1) return idx;
      } else {
        const idx = slots.findIndex((slot) => new Date(slot.start).getDay() === dayNum);
        if (idx !== -1) return idx;
      }
    }

    if (msg.includes('manha') || msg.includes('cedo')) {
      const idx = slots.findIndex((slot) => new Date(slot.start).getHours() < 12);
      if (idx !== -1) return idx;
    }
    if (msg.includes('tarde')) {
      const idx = slots.findIndex((slot) => {
        const hour = new Date(slot.start).getHours();
        return hour >= 12 && hour < 18;
      });
      if (idx !== -1) return idx;
    }
    if (msg.includes('mais tarde') || msg.includes('mais para o fim')) {
      return slots.length - 1;
    }

    const positives = ['pode ser', 'ta bom', 'tudo bem', 'serve', 'combinado', 'beleza', 'fechado', 'ok'];
    if (positives.some((term) => msg.includes(term))) return 0;

    return null;
  }

  static clarify(slots) {
    const options = slots.slice(0, 3).map((slot) => {
      const date = new Date(slot.start);
      return `*${date.toLocaleString('pt-BR', {
        timeZone: BUSINESS_CONFIG.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}*`;
    }).join(' ou ');

    return `Desculpe, não entendi bem qual horário você preferiu 😅\n\nPode me dizer: ${options}?`;
  }
}

class SchedulingManagerClass {
  async processScheduling(phone, name, userMessage) {
    try {
      const clientContext = normalizeSchedulingContext(phone, getClientContext(phone));
      const pendingScheduling = clientContext.pendingScheduling || {};
      const providedName = extractProvidedName(userMessage, pendingScheduling.step === 'waiting_full_name');
      if (providedName) {
        await persistLeadName(phone, providedName);
      }

      const resolvedName = resolveKnownName(phone, providedName, name);
      const intentAnalysis = await SchedulingIntentionAnalyzer.analyzeMessageWithAI(userMessage, {
        pendingScheduling,
        activeScheduling: clientContext.activeScheduling || null,
        knownName: resolvedName,
      });

      if (pendingScheduling.step === 'waiting_full_name') {
        if (!providedName) {
          return {
            success: false,
            message: 'Antes de confirmar, preciso do seu *nome completo* para registrar o agendamento. Pode me informar, por favor?',
          };
        }

        return this.confirmAndCreateEvent(phone, resolveKnownName(phone, providedName, name), pendingScheduling.requestedSlot, true);
      }

      if (!intentAnalysis.hasIntent && !['waiting_slot_selection', 'waiting_day_preference'].includes(pendingScheduling.step)) {
        return { success: false, message: MESSAGE_TEMPLATES.askDateTime(resolvedName || 'tudo bem'), intent: null };
      }

      switch (intentAnalysis.type) {
        case 'confirmation':
          return this.handleConfirmation(phone, resolvedName || 'cliente', pendingScheduling);
        case 'cancellation':
          return this.handleCancellation(phone, resolvedName || 'cliente', pendingScheduling);
        case 'rescheduling':
          return this.handleRescheduling(phone, resolvedName || 'cliente', pendingScheduling);
        case 'scheduling':
        default:
          return this.handleScheduling(phone, resolvedName, userMessage, pendingScheduling);
      }
    } catch (error) {
      console.error('❌ [SchedulingManager] Erro ao processar agendamento:', error);
      return {
        success: false,
        message: 'Desculpe, houve um erro ao processar seu agendamento. Tente novamente em alguns instantes.',
        error: error.message,
      };
    }
  }

  async handleScheduling(phone, name, message, pendingScheduling) {
    const extraction = SchedulingIntentionAnalyzer.extractDateTime(message);

    if (pendingScheduling.step === 'waiting_day_preference' && !extraction.suggestedDate) {
      return {
        success: false,
        message: MESSAGE_TEMPLATES.askPreferredDay(name || 'tudo bem'),
      };
    }

    if (extraction.suggestedDate && extraction.suggestedTime) {
      const requestedSlot = await BusinessHoursManager.findRequestedSlot(
        extraction.suggestedDate,
        extraction.suggestedTime,
      );

      if (requestedSlot) {
        return this.confirmAndCreateEvent(phone, name, requestedSlot);
      }
    }

    if (pendingScheduling.step === 'waiting_slot_selection' && pendingScheduling.availableSlots) {
      if (wantsAlternativeSlots(message) && pendingScheduling.preferredDate) {
        const nextOffset = (pendingScheduling.offeredOffset || 0) + 2;
        const nextSlots = await BusinessHoursManager.getAvailableSlotsForDate(pendingScheduling.preferredDate, 2, nextOffset);

        if (nextSlots.length === 0) {
          return {
            success: false,
            message: MESSAGE_TEMPLATES.askOtherPreferredDay,
          };
        }

        await saveClientContext(phone, {
          pendingScheduling: {
            ...pendingScheduling,
            availableSlots: nextSlots,
            offeredOffset: nextOffset,
            step: 'waiting_slot_selection',
          },
        });

        return {
          success: false,
          message: MESSAGE_TEMPLATES.askOtherTimePreference(nextSlots),
          availableSlots: nextSlots,
        };
      }

      if (extraction.suggestedDate || extraction.suggestedTime) {
        const matchingPendingSlots = pendingScheduling.availableSlots.filter((slot) => {
          const slotDate = new Date(slot.start);
          let matches = true;

          if (extraction.suggestedDate) {
            matches = matches && formatDateOnlyInTimeZone(slotDate, BUSINESS_CONFIG.timezone) === extraction.suggestedDate;
          }

          if (extraction.suggestedTime) {
            const [hour, minute] = extraction.suggestedTime.split(':').map(Number);
            matches = matches && slotDate.getHours() === hour && slotDate.getMinutes() === minute;
          }

          return matches;
        });

        if (matchingPendingSlots.length > 0) {
          return this.confirmAndCreateEvent(phone, name, matchingPendingSlots[0]);
        }

        return {
          success: false,
          message: `Não encontrei esse horário exato livre, mas tenho estas opções para você:\n\n${MESSAGE_TEMPLATES.showAvailable(pendingScheduling.availableSlots)}`,
          availableSlots: pendingScheduling.availableSlots,
        };
      }

      const slotIndex = NaturalSlotParser.parse(message, pendingScheduling.availableSlots);
      if (slotIndex === null) {
        return {
          success: false,
          message: NaturalSlotParser.clarify(pendingScheduling.availableSlots),
          availableSlots: pendingScheduling.availableSlots,
        };
      }
      return this.confirmAndCreateEvent(phone, name, pendingScheduling.availableSlots[slotIndex]);
    }

    if (!extraction.suggestedDate && !extraction.suggestedTime) {
      await saveClientContext(phone, {
        pendingScheduling: {
          ...pendingScheduling,
          lastRequestTime: new Date().toISOString(),
          step: 'waiting_day_preference',
        },
      });

      return {
        success: false,
        message: MESSAGE_TEMPLATES.askPreferredDay(name || 'tudo bem'),
      };
    }

    const availableSlots = extraction.suggestedDate
      ? await BusinessHoursManager.getAvailableSlotsForDate(extraction.suggestedDate, 2, 0)
      : await BusinessHoursManager.getAvailableSlots(2);

    const filteredSlots = availableSlots.filter((slot) => {
      const slotDate = new Date(slot.start);
      let matches = true;
      if (extraction.suggestedDate) {
        matches = matches && formatDateOnlyInTimeZone(slotDate, BUSINESS_CONFIG.timezone) === extraction.suggestedDate;
      }
      if (extraction.suggestedTime) {
        const [hour, minute] = extraction.suggestedTime.split(':').map(Number);
        matches = matches && slotDate.getHours() === hour && slotDate.getMinutes() === minute;
      }
      return matches;
    });

    if (extraction.suggestedDate && extraction.suggestedTime && filteredSlots.length > 0) {
      return this.confirmAndCreateEvent(phone, name, filteredSlots[0]);
    }

    if (extraction.suggestedDate && filteredSlots.length === 0) {
      await saveClientContext(phone, {
        pendingScheduling: {
          ...pendingScheduling,
          lastRequestTime: new Date().toISOString(),
          step: 'waiting_day_preference',
        },
      });

      return {
        success: false,
        message: MESSAGE_TEMPLATES.askOtherPreferredDay,
      };
    }

    if (filteredSlots.length === 0) {
      await saveClientContext(phone, {
        pendingScheduling: {
          ...pendingScheduling,
          availableSlots: [],
          lastRequestTime: new Date().toISOString(),
          preferredDate: extraction.suggestedDate || null,
          step: 'waiting_day_preference',
        },
      });

      return {
        success: false,
        message: extraction.suggestedDate
          ? MESSAGE_TEMPLATES.askOtherPreferredDay
          : MESSAGE_TEMPLATES.askPreferredDay(name || 'tudo bem'),
        availableSlots: [],
      };
    }

    await saveClientContext(phone, {
      pendingScheduling: {
        ...pendingScheduling,
        availableSlots: filteredSlots,
        lastRequestTime: new Date().toISOString(),
        preferredDate: extraction.suggestedDate || null,
        offeredOffset: 0,
        step: 'waiting_slot_selection',
      },
    });

    return {
      success: false,
      message: MESSAGE_TEMPLATES.showAvailable(filteredSlots),
      availableSlots: filteredSlots,
    };
  }

  async handleConfirmation(phone, name, pendingScheduling) {
    if (!pendingScheduling.eventId) {
      return {
        success: false,
        message: 'Você não tem nenhum agendamento pendente para confirmar. Deseja agendar agora?',
      };
    }

    await leadMemory.updateLead(phone, {
      status_agendamento: 'confirmado',
      data_confirmacao: new Date().toISOString(),
      agendado: true,
    });

    const memory = clientMemory.getClientMemory(phone);
    const appointment = (memory.appointments?.scheduled || []).find((item) => item.eventId === pendingScheduling.eventId);
    if (appointment) {
      appointment.status = 'confirmed';
      appointment.confirmed_at = new Date().toISOString();
    }

    await saveClientContext(phone, {
      pendingScheduling: null,
      activeScheduling: {
        eventId: pendingScheduling.eventId,
        selectedDateTime: pendingScheduling.selectedDateTime,
        step: 'confirmed',
      },
    });

    return {
      success: true,
      message: MESSAGE_TEMPLATES.confirmSchedule(name, pendingScheduling.selectedDateTime),
      schedulingData: {
        eventId: pendingScheduling.eventId,
        status: 'confirmado',
      },
    };
  }

  async handleCancellation(phone, name, pendingScheduling) {
    const memory = clientMemory.getClientMemory(phone);
    const scheduling = getActiveScheduling(memory, pendingScheduling);

    if (!scheduling?.eventId) {
      return {
        success: false,
        message: 'Você não tem nenhum agendamento para cancelar.',
      };
    }

    const cancelled = await calendar.cancelEvent(scheduling.eventId);
    if (!cancelled) {
      return {
        success: false,
        message: 'Desculpe, houve um problema ao cancelar. Tente novamente.',
      };
    }

    await leadMemory.updateLead(phone, {
      status_agendamento: 'cancelado',
      data_cancelamento: new Date().toISOString(),
    });

    memory.appointments.cancelled.push({
      eventId: scheduling.eventId,
      cancelled_at: new Date().toISOString(),
      previousDateTime: scheduling.selectedDateTime,
    });

    const scheduled = memory.appointments?.scheduled || [];
    const appointment = scheduled.find((item) => item.eventId === scheduling.eventId);
    if (appointment) {
      appointment.status = 'cancelled';
      appointment.cancelled_at = new Date().toISOString();
    }

    await saveClientContext(phone, { pendingScheduling: null, activeScheduling: null });

    return {
      success: true,
      message: MESSAGE_TEMPLATES.cancellationConfirm(name),
      action: 'cancelled',
    };
  }

  async handleRescheduling(phone, name, pendingScheduling) {
    const memory = clientMemory.getClientMemory(phone);
    const scheduling = getActiveScheduling(memory, pendingScheduling);

    if (!scheduling?.eventId) {
      return {
        success: false,
        message: 'Você não tem nenhum agendamento para remarcar.',
      };
    }

    await calendar.cancelEvent(scheduling.eventId);

    memory.appointments.cancelled.push({
      eventId: scheduling.eventId,
      cancelled_at: new Date().toISOString(),
      previousDateTime: scheduling.selectedDateTime,
      reason: 'rescheduled',
    });

    const scheduled = memory.appointments?.scheduled || [];
    const appointment = scheduled.find((item) => item.eventId === scheduling.eventId);
    if (appointment) {
      appointment.status = 'cancelled';
      appointment.cancelled_at = new Date().toISOString();
      appointment.reason = 'rescheduled';
    }

    const availableSlots = await BusinessHoursManager.getAvailableSlots(2);
    await saveClientContext(phone, {
      activeScheduling: null,
      pendingScheduling: {
        step: 'waiting_day_preference',
        lastRequestTime: new Date().toISOString(),
        availableSlots,
      },
    });

    return {
      success: false,
      message: `${MESSAGE_TEMPLATES.rescheduling(name)}\n\n${MESSAGE_TEMPLATES.askPreferredDay(name)}`,
      availableSlots,
    };
  }

  async confirmAndCreateEvent(phone, name, slot, skipNameCheck = false) {
    try {
      if (!skipNameCheck && !isMeaningfulName(name)) {
        await saveClientContext(phone, {
          pendingScheduling: {
            requestedSlot: slot,
            step: 'waiting_full_name',
            lastRequestTime: new Date().toISOString(),
          },
        });

        return {
          success: false,
          message: 'Perfeito! Antes de confirmar seu horário, preciso do seu *nome completo* para registrar o agendamento. Pode me informar, por favor?',
        };
      }

      const eventResult = await calendar.scheduleEvent({
        summary: `Avaliação Capilar: ${name}`,
        description: `Cliente: ${name}\nTelefone: ${phone}\nAgendado automaticamente via Sofia IA`,
        startTime: slot.start,
        endTime: slot.end,
        attendees: [process.env.NOTIFICATION_EMAIL || 'admin@quality.com'],
      });

      if (!eventResult.success) {
        throw new Error(eventResult.error || 'Falha ao criar evento no calendário');
      }

      clientMemory.recordAppointment(phone, {
        eventId: eventResult.eventId,
        dateTime: slot.start,
        source: 'sofia-scheduling-agent',
        status: 'pending_confirmation',
      });

      await saveClientContext(phone, {
        pendingScheduling: {
          eventId: eventResult.eventId,
          selectedDateTime: slot.start,
          step: 'pending_confirmation',
        },
      });

      await leadMemory.updateLead(phone, {
        status_agendamento: 'pendente_confirmacao',
        data_agendamento: new Date(slot.start).toISOString(),
        hora_agendada: slot.start,
      });

      return {
        success: true,
        message: MESSAGE_TEMPLATES.needConfirmation(name, slot.start),
        schedulingData: {
          eventId: eventResult.eventId,
          dateTime: slot.start,
          status: 'pending_confirmation',
        },
      };
    } catch (error) {
      console.error('❌ Erro ao confirmar agendamento:', error);
      return {
        success: false,
        message: 'Desculpe, houve um erro ao confirmar seu agendamento. Tente novamente.',
        error: error.message,
      };
    }
  }
}

class SchedulingReminders {
  static initializeReminders() {
    if (this.initialized) return;
    this.initialized = true;

    cron.schedule('0 10 * * *', async () => {
      console.log('🔔 [Reminders] Verificando agendamentos para lembrete...');
      await this.sendReminders();
    }, { timezone: BUSINESS_CONFIG.timezone });

    console.log('✅ [Reminders] Agendador de lembretes inicializado');
  }

  static async sendReminders() {
    try {
      const allClients = clientMemory.listAllClients();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = formatDateOnlyInTimeZone(tomorrow, BUSINESS_CONFIG.timezone);

      for (const client of allClients) {
        const memory = clientMemory.getClientMemory(client.phone);
        const appointments = memory.appointments?.scheduled || [];
        const upcoming = appointments.filter((appointment) => {
          if (!appointment.dateTime) return false;
          return String(appointment.dateTime).startsWith(tomorrowDate);
        });

        for (const appointment of upcoming) {
          await messageQueue.enqueue(client.phone, async () => {
            console.log(`🔔 [Reminders] Lembrete pronto para ${client.phone}: ${appointment.dateTime}`);
            return MESSAGE_TEMPLATES.reminder(client.name || memory.personal?.name || 'cliente', appointment.dateTime);
          });
        }
      }

      console.log('✅ [Reminders] Varredura de lembretes concluída');
    } catch (error) {
      console.error('❌ [Reminders] Erro ao enviar lembretes:', error);
    }
  }
}

const SchedulingManager = new SchedulingManagerClass();

module.exports = {
  SchedulingIntentionAnalyzer,
  BusinessHoursManager,
  NaturalSlotParser,
  normalizeSchedulingContext,
  SchedulingManager,
  SchedulingReminders,
  MESSAGE_TEMPLATES,
  BUSINESS_CONFIG,
};
