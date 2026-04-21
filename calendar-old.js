require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');

const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';
const DEFAULT_DURATION_MINUTES = 60;
const CALENDAR_SCOPE = ['https://www.googleapis.com/auth/calendar'];
const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const DEFAULT_BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const TOKEN_FILE_PATH = process.env.GOOGLE_OAUTH_TOKEN_FILE || path.join(__dirname, 'google-oauth-token.json');
const DEFAULT_SERVICE_ACCOUNT_FILE = path.join(__dirname, 'serviceAccountKey.json');

function getOAuthRedirectUri() {
    return process.env.GOOGLE_REDIRECT_URI || `${DEFAULT_BACKEND_URL}/auth/google/callback`;
}

function getFrontendUrl() {
    return DEFAULT_FRONTEND_URL;
}

function hasOAuthConfig() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function hasServiceAccountConfig() {
    return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
}

function createServiceAccountAuth() {
    const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const options = { scopes: CALENDAR_SCOPE };

    if (serviceAccount) {
        const trimmed = serviceAccount.trim();
        if (trimmed.startsWith('{')) {
            options.credentials = JSON.parse(trimmed);
        } else {
            options.keyFile = serviceAccount;
        }
    } else {
        options.keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_SERVICE_ACCOUNT_FILE;
    }

    // Ativa Domain-wide Delegation (impersonation) se configurado
    if (process.env.USE_DOMAIN_DELEGATION === 'true' && process.env.IMPERSONATE_EMAIL) {
        options.clientOptions = {
            subject: process.env.IMPERSONATE_EMAIL
        };
    }

    return new google.auth.GoogleAuth(options);
}

function createOAuthClient() {
    if (!hasOAuthConfig()) {
        throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET são obrigatórios para OAuth');
    }

    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getOAuthRedirectUri(),
    );
}

async function readOAuthTokens() {
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
        const content = await fs.readFile(TOKEN_FILE_PATH, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function writeOAuthTokens(tokens) {
    await fs.writeFile(TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2));
    return tokens;
}

async function getAuthClient() {
    if (hasServiceAccountConfig()) {
        return createServiceAccountAuth().getClient();
    }

    try {
        await fs.access(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_SERVICE_ACCOUNT_FILE);
        return createServiceAccountAuth().getClient();
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    if (hasOAuthConfig()) {
        const oauthClient = createOAuthClient();
        const tokens = await readOAuthTokens();

        if (!tokens?.refresh_token) {
            throw new Error('OAuth do Google Calendar ainda não autorizado. Acesse /auth/google/login para conectar a conta.');
        }

        oauthClient.setCredentials(tokens);
        return oauthClient;
    }

    throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_FILE, GOOGLE_SERVICE_ACCOUNT_JSON ou adicione serviceAccountKey.json na raiz para usar o Google Calendar');
}

async function getCalendarClient() {
    const auth = await getAuthClient();
    return google.calendar({ version: 'v3', auth });
}

function getCalendarId() {
    if (process.env.GOOGLE_CALENDAR_ID) {
        return process.env.GOOGLE_CALENDAR_ID;
    }

    return 'primary';
}

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
    const resolvedYear = year || String(new Date().getFullYear());
    return `${resolvedYear}-${month}-${day}`;
}

function normalizeTime(timeInput) {
    if (!timeInput) {
        throw new Error('Horário é obrigatório');
    }

    const raw = String(timeInput).trim();
    const match = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        throw new Error(`Formato de horário inválido: ${timeInput}`);
    }

    const [, hour, minute, second] = match;
    return `${hour}:${minute}:${second || '00'}-03:00`;
}

function buildDateTime(dateInput, timeInput) {
    return new Date(`${normalizeDate(dateInput)}T${normalizeTime(timeInput)}`).toISOString();
}

function addMinutes(dateTimeIso, minutes) {
    const duration = Number(minutes || DEFAULT_DURATION_MINUTES);
    const endDate = new Date(dateTimeIso);
    endDate.setMinutes(endDate.getMinutes() + duration);
    return endDate.toISOString();
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

async function getEvent(eventId) {
    const calendar = await getCalendarClient();

    const response = await calendar.events.get({
        calendarId: getCalendarId(),
        eventId,
    });

    return response.data;
}

/**
 * Lista eventos em um período.
 */
async function listEvents(startDate, endDate) {
    try {
        const calendar = await getCalendarClient();
        const timeMin = `${normalizeDate(startDate)}T00:00:00-03:00`;
        const timeMax = `${normalizeDate(endDate)}T23:59:59-03:00`;

        const response = await calendar.events.list({
            calendarId: getCalendarId(),
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
        console.error('Erro ao listar eventos no Google Calendar:', error);
        return { error: error.message };
    }
}

/**
 * Mantém compatibilidade com o uso legado no dashboard.
 */
async function getAvailableSlots(date) {
    const eventsResult = await listEvents(date, date);
    if (eventsResult.error) {
        return null;
    }

    return eventsResult.events.map(event => ({
        start: event.start,
        end: event.end,
        title: event.title,
    }));
}

/**
 * Verifica se um período está livre.
 */
async function checkAvailability(date, time, durationMinutes = DEFAULT_DURATION_MINUTES, endTime = null) {
    try {
        const calendar = await getCalendarClient();
        const startDateTime = buildDateTime(date, time);
        const endDateTime = endTime
            ? buildDateTime(date, endTime)
            : addMinutes(startDateTime, durationMinutes);

        const response = await calendar.events.list({
            calendarId: getCalendarId(),
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
        console.error('Erro ao verificar disponibilidade no Google Calendar:', error);
        return { error: error.message };
    }
}

/**
 * Cria um evento.
 */
async function createEvent({ title, description = '', date, time, durationMinutes = DEFAULT_DURATION_MINUTES, endTime = null }) {
    const calendar = await getCalendarClient();
    const startDateTime = buildDateTime(date, time);
    const endDateTime = endTime
        ? buildDateTime(date, endTime)
        : addMinutes(startDateTime, durationMinutes);

    const event = {
        summary: title,
        description,
        start: {
            dateTime: startDateTime,
            timeZone: DEFAULT_TIME_ZONE,
        },
        end: {
            dateTime: endDateTime,
            timeZone: DEFAULT_TIME_ZONE,
        },
    };

    try {
        const response = await calendar.events.insert({
            calendarId: getCalendarId(),
            resource: event,
        });

        return {
            success: true,
            event: formatEvent(response.data),
        };
    } catch (error) {
        console.error('Erro ao criar evento no Google Calendar:', error);
        return { error: error.message };
    }
}

/**
 * Mantém compatibilidade com o fluxo legado.
 */
async function scheduleConsultation(clientName, startTime, endTime) {
    const start = new Date(startTime);
    const event = await createEvent({
        title: `Avaliação Capilar: ${clientName}`,
        description: 'Agendado automaticamente pela Sofia (WhatsApp)',
        date: start.toISOString().slice(0, 10),
        time: start.toISOString().slice(11, 16),
        endTime: new Date(endTime).toISOString().slice(11, 16),
    });

    return Boolean(event.success);
}

/**
 * Atualiza um evento existente.
 */
async function updateEvent({ eventId, title, description, date, time, durationMinutes, endTime }) {
    try {
        const currentEvent = await getEvent(eventId);
        const currentStart = currentEvent.start?.dateTime;
        const currentEnd = currentEvent.end?.dateTime;

        const currentDurationMinutes = currentStart && currentEnd
            ? Math.round((new Date(currentEnd) - new Date(currentStart)) / 60000)
            : DEFAULT_DURATION_MINUTES;

        const nextDate = date || currentStart?.slice(0, 10);
        const nextTime = time || currentStart?.slice(11, 16);

        const nextStart = nextDate && nextTime
            ? buildDateTime(nextDate, nextTime)
            : currentStart;

        const nextEnd = endTime
            ? buildDateTime(nextDate || currentStart?.slice(0, 10), endTime)
            : nextStart
                ? addMinutes(nextStart, durationMinutes || currentDurationMinutes)
                : currentEnd;

        const response = await calendar.events.patch({
            calendarId: getCalendarId(),
            eventId,
            resource: {
                summary: title ?? currentEvent.summary,
                description: description ?? currentEvent.description,
                start: nextStart
                    ? { dateTime: nextStart, timeZone: DEFAULT_TIME_ZONE }
                    : currentEvent.start,
                end: nextEnd
                    ? { dateTime: nextEnd, timeZone: DEFAULT_TIME_ZONE }
                    : currentEvent.end,
            },
        });

        return {
            success: true,
            event: formatEvent(response.data),
        };
    } catch (error) {
        console.error('Erro ao atualizar evento no Google Calendar:', error);
        return { error: error.message };
    }
}

/**
 * Remove um evento.
 */
async function deleteEvent(eventId) {
    try {
        const calendar = await getCalendarClient();
        await calendar.events.delete({
            calendarId: getCalendarId(),
            eventId,
        });

        return {
            success: true,
            eventId,
        };
    } catch (error) {
        console.error('Erro ao deletar evento no Google Calendar:', error);
        return { error: error.message };
    }
}

function getGoogleAuthUrl(state = '') {
    const oauthClient = createOAuthClient();

    return oauthClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: true,
        scope: CALENDAR_SCOPE,
        state,
    });
}

async function handleOAuthCallback(code) {
    if (!code) {
        throw new Error('Código OAuth não informado');
    }

    const oauthClient = createOAuthClient();
    const existingTokens = await readOAuthTokens();
    const { tokens } = await oauthClient.getToken(code);

    const mergedTokens = {
        ...existingTokens,
        ...tokens,
        refresh_token: tokens.refresh_token || existingTokens?.refresh_token,
    };

    if (!mergedTokens.refresh_token) {
        throw new Error('Google não retornou refresh token. Revogue o acesso e tente novamente com prompt de consentimento.');
    }

    await writeOAuthTokens(mergedTokens);
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

async function getAuthStatus() {
    const tokens = await readOAuthTokens().catch(() => null);
    const serviceAccountFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || DEFAULT_SERVICE_ACCOUNT_FILE;
    const hasServiceAccountFile = await fs.access(serviceAccountFile)
        .then(() => true)
        .catch(error => {
            if (error.code === 'ENOENT') {
                return false;
            }

            throw error;
        });
    const serviceAccountEnabled = hasServiceAccountConfig() || hasServiceAccountFile;

    return {
        mode: serviceAccountEnabled ? 'service-account' : hasOAuthConfig() ? 'oauth' : 'unconfigured',
        redirect_uri: getOAuthRedirectUri(),
        frontend_url: getFrontendUrl(),
        calendar_id: getCalendarId(),
        connected: Boolean(tokens?.refresh_token || serviceAccountEnabled),
        token_file: TOKEN_FILE_PATH,
        service_account_file: serviceAccountEnabled ? serviceAccountFile : null,
    };
}

module.exports = {
    checkAvailability,
    createEvent,
    deleteEvent,
    getAvailableSlots,
    getAuthStatus,
    getFrontendUrl,
    getGoogleAuthUrl,
    listEvents,
    handleOAuthCallback,
    scheduleConsultation,
    updateEvent,
};
