require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');

/**
 * Gerenciador de calendário com Domain-wide Delegation
 * @module calendar
 */

const CALENDAR_SCOPE = ['https://www.googleapis.com/auth/calendar'];
const DEFAULT_TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const DEFAULT_SERVICE_ACCOUNT_FILE = path.join(__dirname, 'serviceAccountKey.json');
const TOKEN_FILE_PATH = process.env.GOOGLE_OAUTH_TOKEN_FILE || path.join(__dirname, 'google-oauth-token.json');

class CalendarManager {
  constructor() {
    this.auth = null;
    this.calendar = null;
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.timezone = DEFAULT_TIMEZONE;
    this.serviceAccountFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_SERVICE_ACCOUNT_FILE;
  }

  /**
   * Inicializa autenticação com Service Account
   * @throws {Error} Se falhar ao initializar
   */
  async initialize() {
    try {
      const options = {
        keyFile: this.serviceAccountFile,
        scopes: CALENDAR_SCOPE
      };

      // Ativa Domain-wide Delegation se configurado
      if (process.env.USE_DOMAIN_DELEGATION === 'true' && process.env.IMPERSONATE_EMAIL) {
        options.clientOptions = {
          subject: process.env.IMPERSONATE_EMAIL
        };
      }

      this.auth = new google.auth.GoogleAuth(options);
      this.calendar = google.calendar({ version: 'v3', auth: this.auth });
      console.log('✅ Calendar Manager inicializado');
    } catch (error) {
      console.error('❌ Erro ao inicializar Calendar:', error.message);
      throw error;
    }
  }

  /**
   * Valida se um período está disponível
   * @param {Date|string} startTime - Hora de início (ISO)
   * @param {Date|string} endTime - Hora de término (ISO)
   * @returns {Promise<boolean>}
   */
  async isTimeAvailable(startTime, endTime) {
    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: new Date(startTime).toISOString(),
        timeMax: new Date(endTime).toISOString(),
        singleEvents: true,
        maxResults: 10
      });

      return !response.data.items || response.data.items.length === 0;
    } catch (error) {
      console.error('❌ Erro ao verificar disponibilidade:', error.message);
      return false;
    }
  }

  /**
   * Consulta horários livres em um dia (períodocomercial: 8h-18h)
   * @param {string} date - Data no formato YYYY-MM-DD
   * @param {number} slotDuration - Duração em minutos (padrão: 60)
   * @returns {Promise<Array>} Array de slots disponíveis
   */
  async getAvailableSlots(date, slotDuration = 60) {
    try {
      const timeMin = new Date(`${date}T08:00:00Z`).toISOString();
      const timeMax = new Date(`${date}T18:00:00Z`).toISOString();

      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime'
      });

      const events = response.data.items || [];
      const availableSlots = this.calculateAvailableSlots(date, events, slotDuration);

      return availableSlots;
    } catch (error) {
      console.error('❌ Erro ao buscar slots:', error.message);
      return [];
    }
  }

  /**
   * Calcula horários disponíveis entre 8h e 18h
   * @private
   */
  calculateAvailableSlots(date, events, duration) {
    const slots = [];
    let currentTime = new Date(`${date}T08:00:00Z`);
    const endDay = new Date(`${date}T18:00:00Z`);

    while (currentTime < endDay) {
      const nextTime = new Date(currentTime.getTime() + duration * 60000);

      const isOccupied = events.some(event => {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);
        return currentTime < eventEnd && nextTime > eventStart;
      });

      if (!isOccupied && nextTime <= endDay) {
        slots.push({
          start: currentTime.toISOString().slice(11, 16),
          end: nextTime.toISOString().slice(11, 16),
          available: true
        });
      }

      currentTime = nextTime;
    }

    return slots;
  }

  /**
   * Cria um agendamento
   * @param {object} eventData - Dados do evento
   * @param {string} eventData.summary - Título do evento
   * @param {string} eventData.description - Descrição
   * @param {string} eventData.startTime - ISO timestamp
   * @param {string} eventData.endTime - ISO timestamp
   * @param {Array} eventData.attendees - Lista de emails (opcional)
   * @returns {Promise<object>}
   */
  async scheduleEvent(eventData) {
    const { summary, description = '', startTime, endTime, attendees = [] } = eventData;

    if (!summary || !startTime || !endTime) {
      throw new Error('Dados obrigatórios faltando: summary, startTime, endTime');
    }

    try {
      const event = {
        summary,
        description,
        start: {
          dateTime: startTime,
          timeZone: this.timezone
        },
        end: {
          dateTime: endTime,
          timeZone: this.timezone
        },
        attendees: attendees.map(email => ({ email }))
      };

      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        resource: event,
        sendUpdates: 'all'
      });

      console.log(`✅ Evento criado: ${response.data.htmlLink}`);

      return {
        success: true,
        eventId: response.data.id,
        link: response.data.htmlLink,
        event: response.data
      };
    } catch (error) {
      console.error('❌ Erro ao criar evento:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Agenda uma consulta (helper específico para Quality Hair)
   * @param {string} clientName - Nome do cliente
   * @param {string} startTime - ISO timestamp
   * @param {string} endTime - ISO timestamp
   * @returns {Promise<object>}
   */
  async scheduleConsultation(clientName, startTime, endTime) {
    return this.scheduleEvent({
      summary: `Avaliação Capilar: ${clientName}`,
      description: 'Agendado automaticamente pela Sofia IA',
      startTime,
      endTime
    });
  }

  /**
   * Lista eventos de um período
   * @param {Date|string} startDate - Data inicial (ISO)
   * @param {Date|string} endDate - Data final (ISO)
   * @returns {Promise<Array>}
   */
  async listEvents(startDate, endDate) {
    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: new Date(startDate).toISOString(),
        timeMax: new Date(endDate).toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      return (response.data.items || []).map(event => ({
        id: event.id,
        title: event.summary,
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        description: event.description
      }));
    } catch (error) {
      console.error('❌ Erro ao listar eventos:', error.message);
      return [];
    }
  }

  /**
   * Atualiza um evento existente
   * @param {string} eventId - ID do evento
   * @param {object} updateData - Dados a atualizar
   * @returns {Promise<object>}
   */
  async updateEvent(eventId, updateData) {
    try {
      const response = await this.calendar.events.patch({
        calendarId: this.calendarId,
        eventId,
        resource: updateData
      });

      return {
        success: true,
        eventId: response.data.id
      };
    } catch (error) {
      console.error('❌ Erro ao atualizar evento:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cancela um evento
   * @param {string} eventId - ID do evento
   * @returns {Promise<boolean>}
   */
  async cancelEvent(eventId) {
    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId
      });

      console.log(`✅ Evento ${eventId} cancelado`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao cancelar evento:', error.message);
      return false;
    }
  }

  /**
   * Obtém status de autenticação
   * @returns {Promise<object>}
   */
  async getAuthStatus() {
    try {
      const fileExists = await fs
        .access(this.serviceAccountFile)
        .then(() => true)
        .catch(() => false);

      return {
        mode: process.env.USE_DOMAIN_DELEGATION === 'true' ? 'domain-delegation' : 'service-account',
        calendarId: this.calendarId,
        impersonateEmail: process.env.IMPERSONATE_EMAIL || null,
        connected: fileExists,
        serviceAccountFile: fileExists ? this.serviceAccountFile : null
      };
    } catch (error) {
      console.error('❌ Erro ao obter status:', error.message);
      return { connected: false, error: error.message };
    }
  }
}

// Exporta instância singleton
const manager = new CalendarManager();

// Inicializa automaticamente ao carregar
(async () => {
  try {
    await manager.initialize();
  } catch (error) {
    console.error('⚠️ Aviso: Calendar Manager falhou na inicialização:', error.message);
  }
})();

module.exports = manager;
