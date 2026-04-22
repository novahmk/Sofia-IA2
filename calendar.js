require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');

const CALENDAR_SCOPE = ['https://www.googleapis.com/auth/calendar'];
const DEFAULT_TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const DEFAULT_DURATION_MINUTES = 60;
const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const DEFAULT_BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const DEFAULT_SERVICE_ACCOUNT_FILE = path.join(__dirname, 'serviceAccountKey.json');
const TOKEN_FILE_PATH = process.env.GOOGLE_OAUTH_TOKEN_FILE || path.join(__dirname, 'google-oauth-token.json');

function normalizeDate(dateInput) {
  if (!dateInput) {
    throw new Error('Data é obrigatória');
  }

  const raw = String(dateInput).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/^(\d{2})[\/-](\d{2})(?:[\/-](\d{4}))?$/);
  if (!match) {
    throw new Error(`Formato de data inválido: ${dateInput}`);
  }

  const [, day, month, year] = match;
  return `${year || String(new Date().getFullYear())}-${month}-${day}`;
}

function normalizeTime(timeInput) {
  if (!timeInput) {
    throw new Error('Horário é obrigatório');
  }

  const raw = String(timeInput).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Formato de horário inválido: ${timeInput}`);
  }

  const [, hour, minute, second] = match;
  return `${hour.padStart(2, '0')}:${minute}:${second || '00'}-03:00`;
}

function buildDateTime(dateInput, timeInput) {
  return new Date(`${normalizeDate(dateInput)}T${normalizeTime(timeInput)}`).toISOString();
}

function addMinutes(dateTimeIso, minutes) {
  const nextDate = new Date(dateTimeIso);
  nextDate.setMinutes(nextDate.getMinutes() + Number(minutes || DEFAULT_DURATION_MINUTES));
  return nextDate.toISOString();
}

function formatEvent(event) {
  return {
    id: event.id,
    title: event.summary || 'Sem título',
    description: event.description || '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    status: event.status || 'confirmed',
    link: event.htmlLink || null,
  };
}

class CalendarManager {
  constructor() {
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.timezone = DEFAULT_TIMEZONE;
    this.tokenFilePath = TOKEN_FILE_PATH;
    this.defaultDurationMinutes = DEFAULT_DURATION_MINUTES;
    this.defaultFrontendUrl = DEFAULT_FRONTEND_URL;
    this.defaultBackendUrl = DEFAULT_BACKEND_URL;
    this.defaultServiceAccountFile = DEFAULT_SERVICE_ACCOUNT_FILE;
  }

  hasOAuthConfig() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }

  getCalendarId() {
    return process.env.GOOGLE_CALENDAR_ID || this.calendarId || 'primary';
  }

  getFrontendUrl() {
    return process.env.FRONTEND_URL || this.defaultFrontendUrl;
  }

  getOAuthRedirectUri() {
    return process.env.GOOGLE_REDIRECT_URI || `${process.env.BACKEND_URL || this.defaultBackendUrl}/auth/google/callback`;
  }

  createOAuthClient() {
    if (!this.hasOAuthConfig()) {
      throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET são obrigatórios para OAuth');
    }

    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      this.getOAuthRedirectUri(),
    );
  }

  async readOAuthTokens() {
    if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      return {
        refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
        access_token: process.env.GOOGLE_OAUTH_ACCESS_TOKEN || undefined,
        scope: process.env.GOOGLE_OAUTH_SCOPE || CALENDAR_SCOPE.join(' '),
        token_type: process.env.GOOGLE_OAUTH_TOKEN_TYPE || 'Bearer',
        expiry_date: process.env.GOOGLE_OAUTH_EXPIRY_DATE ? Number(process.env.GOOGLE_OAUTH_EXPIRY_DATE) : undefined,
      };
    }

    try {
      const content = await fs.readFile(this.tokenFilePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async writeOAuthTokens(tokens) {
    await fs.writeFile(this.tokenFilePath, JSON.stringify(tokens, null, 2));
    return tokens;
  }

  async resolveServiceAccountConfig() {
    const rawInlineJson = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    const configuredFile = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim();
    const normalizedInlineJson = rawInlineJson.replace(/^\uFEFF/, '');

    if (normalizedInlineJson) {
      if (normalizedInlineJson.startsWith('{')) {
        return {
          source: 'GOOGLE_SERVICE_ACCOUNT_JSON',
          credentials: JSON.parse(normalizedInlineJson),
        };
      }

      const resolvedPath = path.resolve(process.cwd(), normalizedInlineJson);
      await fs.access(resolvedPath);
      return {
        source: normalizedInlineJson,
        keyFile: resolvedPath,
      };
    }

    if (configuredFile) {
      const resolvedPath = path.resolve(process.cwd(), configuredFile);
      await fs.access(resolvedPath);
      return {
        source: configuredFile,
        keyFile: resolvedPath,
      };
    }

    try {
      await fs.access(this.defaultServiceAccountFile);
      return {
        source: this.defaultServiceAccountFile,
        keyFile: this.defaultServiceAccountFile,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  async getAuthDebugInfo() {
    const rawInlineEnv = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '');
    const trimmedInlineEnv = rawInlineEnv.trim();
    const normalizedInlineEnv = trimmedInlineEnv.replace(/^\uFEFF/, '');
    const configuredFile = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim();

    const defaultServiceAccountFileExists = await fs.access(this.defaultServiceAccountFile)
      .then(() => true)
      .catch((error) => {
        if (error.code === 'ENOENT') {
          return false;
        }

        throw error;
      });

    try {
      const resolvedConfig = await this.resolveServiceAccountConfig();

      return {
        hasInlineEnv: Boolean(rawInlineEnv),
        inlineEnvLength: rawInlineEnv.length,
        inlineTrimmedLength: trimmedInlineEnv.length,
        inlineHasBom: rawInlineEnv.includes('\uFEFF'),
        inlineStartsWithBrace: normalizedInlineEnv.startsWith('{'),
        inlineLooksLikePath: Boolean(normalizedInlineEnv) && !normalizedInlineEnv.startsWith('{'),
        hasConfiguredFileEnv: Boolean(configuredFile),
        configuredFile: configuredFile || null,
        defaultServiceAccountFile: this.defaultServiceAccountFile,
        defaultServiceAccountFileExists,
        resolvedSource: resolvedConfig?.source || null,
        resolvedKind: resolvedConfig?.credentials ? 'credentials' : resolvedConfig?.keyFile ? 'keyFile' : null,
      };
    } catch (error) {
      return {
        hasInlineEnv: Boolean(rawInlineEnv),
        inlineEnvLength: rawInlineEnv.length,
        inlineTrimmedLength: trimmedInlineEnv.length,
        inlineHasBom: rawInlineEnv.includes('\uFEFF'),
        inlineStartsWithBrace: normalizedInlineEnv.startsWith('{'),
        inlineLooksLikePath: Boolean(normalizedInlineEnv) && !normalizedInlineEnv.startsWith('{'),
        hasConfiguredFileEnv: Boolean(configuredFile),
        configuredFile: configuredFile || null,
        defaultServiceAccountFile: this.defaultServiceAccountFile,
        defaultServiceAccountFileExists,
        resolvedSource: null,
        resolvedKind: null,
        resolutionError: error.message,
      };
    }
  }

  buildGoogleAuthOptions(serviceAccountConfig) {
    const options = { scopes: CALENDAR_SCOPE };

    if (serviceAccountConfig?.credentials) {
      options.credentials = serviceAccountConfig.credentials;
    } else if (serviceAccountConfig?.keyFile) {
      options.keyFile = serviceAccountConfig.keyFile;
    }

    if (process.env.USE_DOMAIN_DELEGATION === 'true' && process.env.IMPERSONATE_EMAIL) {
      options.clientOptions = {
        subject: process.env.IMPERSONATE_EMAIL,
      };
    }

    return options;
  }

  async getAuthClient() {
    const serviceAccountConfig = await this.resolveServiceAccountConfig();
    if (serviceAccountConfig) {
      const auth = new google.auth.GoogleAuth(this.buildGoogleAuthOptions(serviceAccountConfig));
      return auth.getClient();
    }

    if (this.hasOAuthConfig()) {
      const oauthClient = this.createOAuthClient();
      const tokens = await this.readOAuthTokens();

      if (!tokens?.refresh_token) {
        throw new Error('OAuth do Google Calendar ainda não autorizado. Acesse /auth/google/login para conectar a conta.');
      }

      oauthClient.setCredentials(tokens);
      return oauthClient;
    }

    throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_FILE, OAuth ou adicione serviceAccountKey.json na raiz para usar o Google Calendar');
  }

  async getCalendarClient() {
    const auth = await this.getAuthClient();
    return google.calendar({ version: 'v3', auth });
  }

  async initialize() {
    await this.getCalendarClient();
    console.log('✅ Calendar Manager inicializado');
  }

  async getEvent(eventId) {
    const calendar = await this.getCalendarClient();
    const response = await calendar.events.get({
      calendarId: this.getCalendarId(),
      eventId,
    });

    return response.data;
  }

  async listEvents(startDate, endDate) {
    try {
      const calendar = await this.getCalendarClient();
      const timeMin = `${normalizeDate(startDate)}T00:00:00-03:00`;
      const timeMax = `${normalizeDate(endDate)}T23:59:59-03:00`;
      const response = await calendar.events.list({
        calendarId: this.getCalendarId(),
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];
      return {
        period_start: normalizeDate(startDate),
        period_end: normalizeDate(endDate),
        total: events.length,
        events: events.map(formatEvent),
      };
    } catch (error) {
      console.error('❌ Erro ao listar eventos no Google Calendar:', error.message);
      return { error: error.message };
    }
  }

  async checkAvailability(date, time, durationMinutes = this.defaultDurationMinutes, endTime = null) {
    try {
      const calendar = await this.getCalendarClient();
      const startDateTime = buildDateTime(date, time);
      const endDateTime = endTime
        ? buildDateTime(date, endTime)
        : addMinutes(startDateTime, durationMinutes);

      const response = await calendar.events.list({
        calendarId: this.getCalendarId(),
        timeMin: startDateTime,
        timeMax: endDateTime,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const conflicts = (response.data.items || []).map(formatEvent);
      return {
        available: conflicts.length === 0,
        start: startDateTime,
        end: endDateTime,
        conflicts,
      };
    } catch (error) {
      console.error('❌ Erro ao verificar disponibilidade:', error.message);
      return { error: error.message };
    }
  }

  async isTimeAvailable(startTime, endTime) {
    try {
      const calendar = await this.getCalendarClient();
      const response = await calendar.events.list({
        calendarId: this.getCalendarId(),
        timeMin: new Date(startTime).toISOString(),
        timeMax: new Date(endTime).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20,
      });

      return (response.data.items || []).length === 0;
    } catch (error) {
      console.error('❌ Erro ao verificar disponibilidade:', error.message);
      return false;
    }
  }

  async getAvailableSlots(date, slotDuration = this.defaultDurationMinutes) {
    try {
      const normalizedDate = normalizeDate(date);
      const eventsResult = await this.listEvents(normalizedDate, normalizedDate);
      if (eventsResult.error) {
        return [];
      }

      const slots = [];
      let currentTime = new Date(buildDateTime(normalizedDate, '08:00'));
      const endDay = new Date(buildDateTime(normalizedDate, '18:00'));
      const events = eventsResult.events || [];

      while (currentTime < endDay) {
        const nextTime = new Date(currentTime.getTime() + Number(slotDuration) * 60000);
        const isOccupied = events.some((event) => {
          const eventStart = new Date(event.start);
          const eventEnd = new Date(event.end);
          return currentTime < eventEnd && nextTime > eventStart;
        });

        if (!isOccupied && nextTime <= endDay) {
          slots.push({
            start: currentTime.toISOString(),
            end: nextTime.toISOString(),
            available: true,
          });
        }

        currentTime = nextTime;
      }

      return slots;
    } catch (error) {
      console.error('❌ Erro ao buscar slots:', error.message);
      return [];
    }
  }

  async createEvent({ title, description = '', date, time, durationMinutes = this.defaultDurationMinutes, endTime = null, attendees = [] }) {
    try {
      const calendar = await this.getCalendarClient();
      const startDateTime = buildDateTime(date, time);
      const endDateTime = endTime
        ? buildDateTime(date, endTime)
        : addMinutes(startDateTime, durationMinutes);

      const response = await calendar.events.insert({
        calendarId: this.getCalendarId(),
        resource: {
          summary: title,
          description,
          start: { dateTime: startDateTime, timeZone: this.timezone },
          end: { dateTime: endDateTime, timeZone: this.timezone },
          attendees: attendees.map((email) => ({ email })),
        },
        sendUpdates: 'all',
      });

      return {
        success: true,
        event: formatEvent(response.data),
      };
    } catch (error) {
      console.error('❌ Erro ao criar evento no Google Calendar:', error.message);
      return { error: error.message };
    }
  }

  async scheduleEvent({ summary, description = '', startTime, endTime, attendees = [] }) {
    if (!summary || !startTime || !endTime) {
      throw new Error('Dados obrigatórios faltando: summary, startTime, endTime');
    }

    try {
      const calendar = await this.getCalendarClient();
      const response = await calendar.events.insert({
        calendarId: this.getCalendarId(),
        resource: {
          summary,
          description,
          start: { dateTime: new Date(startTime).toISOString(), timeZone: this.timezone },
          end: { dateTime: new Date(endTime).toISOString(), timeZone: this.timezone },
          attendees: attendees.map((email) => ({ email })),
        },
        sendUpdates: 'all',
      });

      return {
        success: true,
        eventId: response.data.id,
        link: response.data.htmlLink,
        event: response.data,
      };
    } catch (error) {
      console.error('❌ Erro ao criar evento:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async scheduleConsultation(clientName, startTime, endTime) {
    return this.scheduleEvent({
      summary: `Avaliação Capilar: ${clientName}`,
      description: 'Agendado automaticamente pela Sofia IA',
      startTime,
      endTime,
    });
  }

  async updateEvent(eventIdOrPayload, updateData = {}) {
    const payload = typeof eventIdOrPayload === 'object' && eventIdOrPayload !== null
      ? eventIdOrPayload
      : { eventId: eventIdOrPayload, ...(updateData || {}) };
    const { eventId, title, description, date, time, durationMinutes, endTime } = payload;

    try {
      const calendar = await this.getCalendarClient();
      const currentEvent = await this.getEvent(eventId);
      const currentStart = currentEvent.start?.dateTime;
      const currentEnd = currentEvent.end?.dateTime;
      const currentDurationMinutes = currentStart && currentEnd
        ? Math.max(1, Math.round((new Date(currentEnd) - new Date(currentStart)) / 60000))
        : this.defaultDurationMinutes;
      const nextDate = date || currentStart?.slice(0, 10);
      const nextTime = time || currentStart?.slice(11, 16);
      const nextStart = nextDate && nextTime ? buildDateTime(nextDate, nextTime) : currentStart;
      const nextEnd = endTime
        ? buildDateTime(nextDate || currentStart?.slice(0, 10), endTime)
        : nextStart
          ? addMinutes(nextStart, durationMinutes || currentDurationMinutes)
          : currentEnd;

      const response = await calendar.events.patch({
        calendarId: this.getCalendarId(),
        eventId,
        resource: {
          summary: title ?? currentEvent.summary,
          description: description ?? currentEvent.description,
          start: nextStart
            ? { dateTime: nextStart, timeZone: this.timezone }
            : currentEvent.start,
          end: nextEnd
            ? { dateTime: nextEnd, timeZone: this.timezone }
            : currentEvent.end,
        },
        sendUpdates: 'all',
      });

      return {
        success: true,
        event: formatEvent(response.data),
      };
    } catch (error) {
      console.error('❌ Erro ao atualizar evento:', error.message);
      return { error: error.message };
    }
  }

  async deleteEvent(eventId) {
    try {
      const calendar = await this.getCalendarClient();
      await calendar.events.delete({
        calendarId: this.getCalendarId(),
        eventId,
        sendUpdates: 'all',
      });

      return { success: true, eventId };
    } catch (error) {
      console.error('❌ Erro ao deletar evento:', error.message);
      return { error: error.message };
    }
  }

  async cancelEvent(eventId) {
    const result = await this.deleteEvent(eventId);
    return Boolean(result.success);
  }

  getGoogleAuthUrl(state = '') {
    const oauthClient = this.createOAuthClient();
    return oauthClient.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: CALENDAR_SCOPE,
      state,
    });
  }

  async handleOAuthCallback(code) {
    if (!code) {
      throw new Error('Código OAuth não informado');
    }

    const oauthClient = this.createOAuthClient();
    const existingTokens = await this.readOAuthTokens();
    const { tokens } = await oauthClient.getToken(code);
    const mergedTokens = {
      ...existingTokens,
      ...tokens,
      refresh_token: tokens.refresh_token || existingTokens?.refresh_token,
    };

    if (!mergedTokens.refresh_token) {
      throw new Error('Google não retornou refresh token. Revogue o acesso e tente novamente com prompt de consentimento.');
    }

    await this.writeOAuthTokens(mergedTokens);
    oauthClient.setCredentials(mergedTokens);

    return {
      success: true,
      tokens: {
        scope: mergedTokens.scope,
        expiry_date: mergedTokens.expiry_date || null,
        has_refresh_token: Boolean(mergedTokens.refresh_token),
      },
    };
  }

  async getAuthStatus() {
    try {
      const serviceAccountConfig = await this.resolveServiceAccountConfig();
      const tokens = await this.readOAuthTokens().catch(() => null);
      const mode = serviceAccountConfig ? 'service-account' : this.hasOAuthConfig() ? 'oauth' : 'unconfigured';

      return {
        mode,
        connected: Boolean(serviceAccountConfig || tokens?.refresh_token),
        calendarId: this.getCalendarId(),
        redirectUri: this.getOAuthRedirectUri(),
        frontendUrl: this.getFrontendUrl(),
        tokenFile: this.tokenFilePath,
        serviceAccountFile: serviceAccountConfig?.keyFile || null,
        serviceAccountSource: serviceAccountConfig?.source || null,
        impersonateEmail: process.env.IMPERSONATE_EMAIL || null,
      };
    } catch (error) {
      console.error('❌ Erro ao obter status do Google Calendar:', error.message);
      return {
        connected: false,
        mode: 'error',
        error: error.message,
      };
    }
  }
}

const manager = new CalendarManager();

(async () => {
  try {
    await manager.initialize();
  } catch (error) {
    console.warn('⚠️ Aviso: Calendar Manager falhou na inicialização:', error.message);
  }
})();

module.exports = manager;
