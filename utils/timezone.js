'use strict';

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

function getConfiguredTimeZone() {
  return String(process.env.TIMEZONE || process.env.TZ || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
}

function parseTimeParts(timeInput) {
  const raw = String(timeInput || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Formato de horário inválido: ${timeInput}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || '0');

  return { hour, minute, second };
}

function getTimeZoneOffsetMinutes(dateInput, timeZone = getConfiguredTimeZone()) {
  const date = new Date(dateInput);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const zonedTimestamp = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return (zonedTimestamp - date.getTime()) / 60000;
}

function buildIsoFromDateAndTime(dateInput, timeInput, timeZone = getConfiguredTimeZone()) {
  const [year, month, day] = String(dateInput).split('-').map(Number);
  const { hour, minute, second } = parseTimeParts(timeInput);
  const baseUtcTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  let resolvedTimestamp = baseUtcTimestamp;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(resolvedTimestamp, timeZone);
    resolvedTimestamp = baseUtcTimestamp - offsetMinutes * 60000;
  }

  return new Date(resolvedTimestamp).toISOString();
}

function formatDateOnlyInTimeZone(dateInput, timeZone = getConfiguredTimeZone()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(dateInput))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  buildIsoFromDateAndTime,
  formatDateOnlyInTimeZone,
  getConfiguredTimeZone,
};