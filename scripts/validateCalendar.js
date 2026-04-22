'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const calendar = require('../calendar');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const statusWithoutCreds = await calendar.getAuthStatus();
  assert(
    ['unconfigured', 'oauth', 'service-account', 'error'].includes(statusWithoutCreds.mode),
    `modo inesperado: ${JSON.stringify(statusWithoutCreds)}`,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-test-'));
  const serviceAccountPath = path.join(tempDir, 'sa.json');
  fs.writeFileSync(serviceAccountPath, JSON.stringify({ client_email: 'bot@example.com', private_key: 'dummy' }));

  const originalEnv = {
    GOOGLE_SERVICE_ACCOUNT_FILE: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  };

  process.env.GOOGLE_SERVICE_ACCOUNT_FILE = serviceAccountPath;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const statusWithFile = await calendar.getAuthStatus();
  assert(statusWithFile.mode === 'service-account', `esperado service-account via arquivo: ${JSON.stringify(statusWithFile)}`);
  assert(statusWithFile.serviceAccountFile && statusWithFile.serviceAccountFile.endsWith('sa.json'), `arquivo inesperado: ${JSON.stringify(statusWithFile)}`);

  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'inline@example.com', private_key: 'inline-key' });
  delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const statusWithInline = await calendar.getAuthStatus();
  const debugWithInline = await calendar.getAuthDebugInfo();
  assert(statusWithInline.mode === 'service-account', `esperado service-account via inline: ${JSON.stringify(statusWithInline)}`);
  assert(statusWithInline.serviceAccountSource === 'GOOGLE_SERVICE_ACCOUNT_JSON', `source inesperado: ${JSON.stringify(statusWithInline)}`);
  assert(debugWithInline.inlineStartsWithBrace === true, `inline JSON deveria começar com chave: ${JSON.stringify(debugWithInline)}`);
  assert(debugWithInline.resolvedKind === 'credentials', `inline JSON deveria resolver credentials: ${JSON.stringify(debugWithInline)}`);

  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = `\uFEFF${JSON.stringify({ client_email: 'bom@example.com', private_key: 'bom-key' })}`;
  const statusWithBomInline = await calendar.getAuthStatus();
  const debugWithBomInline = await calendar.getAuthDebugInfo();
  assert(statusWithBomInline.mode === 'service-account', `esperado service-account via inline com BOM: ${JSON.stringify(statusWithBomInline)}`);
  assert(statusWithBomInline.serviceAccountSource === 'GOOGLE_SERVICE_ACCOUNT_JSON', `source com BOM inesperado: ${JSON.stringify(statusWithBomInline)}`);
  assert(debugWithBomInline.inlineHasBom === true, `BOM deveria ser detectado: ${JSON.stringify(debugWithBomInline)}`);
  assert(debugWithBomInline.resolvedKind === 'credentials', `inline com BOM deveria resolver credentials: ${JSON.stringify(debugWithBomInline)}`);

  if (typeof originalEnv.GOOGLE_SERVICE_ACCOUNT_FILE === 'string') {
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE = originalEnv.GOOGLE_SERVICE_ACCOUNT_FILE;
  } else {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  }
  if (typeof originalEnv.GOOGLE_SERVICE_ACCOUNT_JSON === 'string') {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = originalEnv.GOOGLE_SERVICE_ACCOUNT_JSON;
  } else {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  }

  const store = new Map();
  let counter = 0;
  const fakeCalendar = {
    events: {
      list: async ({ timeMin, timeMax }) => {
        const start = new Date(timeMin);
        const end = new Date(timeMax);
        const items = [...store.values()].filter((event) => {
          const eventStart = new Date(event.start.dateTime);
          const eventEnd = new Date(event.end.dateTime);
          return eventStart < end && eventEnd > start;
        });
        return { data: { items } };
      },
      insert: async ({ resource }) => {
        counter += 1;
        const id = `evt-${counter}`;
        const event = {
          id,
          summary: resource.summary,
          description: resource.description,
          start: resource.start,
          end: resource.end,
          htmlLink: `https://calendar.google.com/${id}`,
          status: 'confirmed',
        };
        store.set(id, event);
        return { data: event };
      },
      get: async ({ eventId }) => ({ data: store.get(eventId) }),
      patch: async ({ eventId, resource }) => {
        const current = store.get(eventId);
        const updated = {
          ...current,
          summary: resource.summary,
          description: resource.description,
          start: resource.start,
          end: resource.end,
        };
        store.set(eventId, updated);
        return { data: updated };
      },
      delete: async ({ eventId }) => {
        store.delete(eventId);
        return { data: {} };
      },
    },
  };

  const originalGetCalendarClient = calendar.getCalendarClient.bind(calendar);
  calendar.getCalendarClient = async () => fakeCalendar;

  const created = await calendar.scheduleEvent({
    summary: 'Teste agendamento Sofia',
    description: 'Smoke test local',
    startTime: '2026-04-23T15:00:00.000Z',
    endTime: '2026-04-23T16:00:00.000Z',
    attendees: ['teste@example.com'],
  });
  assert(created.success === true, `falha ao criar evento fake: ${JSON.stringify(created)}`);
  assert(store.has(created.eventId), 'evento fake não foi persistido');

  const unavailable = await calendar.isTimeAvailable('2026-04-23T15:00:00.000Z', '2026-04-23T16:00:00.000Z');
  assert(unavailable === false, 'horário ocupado deveria retornar indisponível');

  const updated = await calendar.updateEvent({
    eventId: created.eventId,
    title: 'Teste agendamento Sofia atualizado',
    date: '2026-04-23',
    time: '17:00',
    durationMinutes: 30,
  });
  assert(updated.success === true, `falha ao atualizar evento fake: ${JSON.stringify(updated)}`);
  assert(store.get(created.eventId).summary === 'Teste agendamento Sofia atualizado', 'evento fake não foi atualizado');

  const cancelled = await calendar.cancelEvent(created.eventId);
  assert(cancelled === true, 'cancelEvent deveria retornar true');
  assert(!store.has(created.eventId), 'evento fake deveria ter sido removido');

  calendar.getCalendarClient = originalGetCalendarClient;
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('CALENDAR_VALIDATION_OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});