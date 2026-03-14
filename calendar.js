require('dotenv').config();
const { google } = require('googleapis');

// Inicializa a autenticação com Conta de Serviço do Google
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

/**
 * Consulta horários livres na agenda do especialista
 * @param {string} date - Data no formato YYYY-MM-DD
 */
async function getAvailableSlots(date) {
    try {
        const timeMin = new Date(`${date}T08:00:00Z`).toISOString();
        const timeMax = new Date(`${date}T18:00:00Z`).toISOString();

        const response = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items;

        // Esta é uma lógica simplificada. Em um cenário real, cruzaríamos 
        // os eventos existentes com o horário comercial para ver "o que sobrou" livre.
        return events.map(e => ({
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            title: e.summary
        }));

    } catch (error) {
        console.error('Erro ao buscar horários no Google Calendar:', error);
        return null;
    }
}

/**
 * Cria um agendamento na agenda do especialista
 * @param {string} clientName - Nome do cliente
 * @param {string} startTime - Início no formato ISO
 * @param {string} endTime - Fim no formato ISO
 */
async function scheduleConsultation(clientName, startTime, endTime) {
    const event = {
        summary: `Avaliação Capilar: ${clientName}`,
        description: `Agendado automaticamente pela Sofia (WhatsApp)`,
        start: {
            dateTime: startTime,
            timeZone: 'America/Sao_Paulo',
        },
        end: {
            dateTime: endTime,
            timeZone: 'America/Sao_Paulo',
        },
    };

    try {
        const response = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        });
        console.log('Agendamento criado! Link:', response.data.htmlLink);
        return true;
    } catch (error) {
        console.error('Erro ao criar evento no Google Calendar:', error);
        return false;
    }
}

module.exports = { getAvailableSlots, scheduleConsultation };
