'use strict';

const DEFAULT_ALERT_PHONE = '5511993521100';

const monitorState = {
  started: false,
  intervalId: null,
  lastStatus: 'unknown',
  lastAlertKey: null,
  lastAlertAt: 0,
  lastSummary: null,
  sendMessage: null,
};

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/^whatsapp:/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/[^0-9]/g, '')
    .trim();
}

function getAlertPhone() {
  const adminPhone = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map((phone) => normalizePhone(phone))
    .find(Boolean);

  return normalizePhone(process.env.MONITORING_ALERT_PHONE || adminPhone || DEFAULT_ALERT_PHONE);
}

function getPingToken() {
  return String(process.env.MONITORING_PING_TOKEN || process.env.WEBHOOK_API_KEY || '').trim();
}

function getAllowedPingPhones() {
  return new Set([getAlertPhone()].filter(Boolean));
}

function parsePingCommand(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^\/(ping|health)(?:\s+(.+))?$/i);

  if (!match) {
    return { isPingCommand: false, command: null, providedToken: '', args: [] };
  }

  const args = String(match[2] || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    isPingCommand: true,
    command: match[1].toLowerCase(),
    providedToken: args[0] || '',
    args,
  };
}

function authorizePingCommand(phone, providedToken = '') {
  const normalizedPhone = normalizePhone(phone);

  if (getAllowedPingPhones().has(normalizedPhone)) {
    return { authorized: true, mode: 'allowlist' };
  }

  return { authorized: false, mode: 'denied' };
}

function getMonitorIntervalMs() {
  return parsePositiveInt(process.env.MONITOR_INTERVAL_MS, 60 * 60 * 1000);
}

function getAlertRepeatMs() {
  return parsePositiveInt(process.env.MONITOR_ALERT_REPEAT_MS, 60 * 60 * 1000);
}

function getMonitorStartDelayMs() {
  return parsePositiveInt(process.env.MONITOR_START_DELAY_MS, 20 * 1000);
}

function normalizeServiceStatus(service) {
  if (service?.status === 'online') return 'ok';
  if (service?.status === 'warning') return 'warning';
  return 'error';
}

function summarizeHealth(checks, timestamp = new Date().toISOString()) {
  const messaging = checks?.uazapi || {
    status: 'error',
    detail: 'Gateway de mensagens indisponivel',
    label: 'WhatsApp',
  };

  const summary = {
    status: 'ok',
    server: 'ok',
    openai: normalizeServiceStatus(checks?.openai),
    messaging: normalizeServiceStatus(messaging),
    database: normalizeServiceStatus(checks?.database),
    calendar: normalizeServiceStatus(checks?.calendar),
    timestamp,
    services: checks || {},
    criticalFailures: [],
  };

  if (summary.openai === 'error') {
    summary.criticalFailures.push('OpenAI');
  }
  if (summary.messaging === 'error') {
    summary.criticalFailures.push(messaging.label || 'WhatsApp');
  }

  if (summary.criticalFailures.length > 0) {
    summary.status = 'error';
  } else if (
    [summary.openai, summary.messaging, summary.database, summary.calendar].some(
      (status) => status === 'warning' || status === 'error',
    )
  ) {
    summary.status = 'degraded';
  }

  return summary;
}

function formatStatusLabel(status) {
  if (status === 'ok') return 'ok';
  if (status === 'warning') return 'alerta';
  return 'erro';
}

function buildAlertKey(summary) {
  return JSON.stringify({
    status: summary.status,
    openai: summary.services?.openai?.detail || summary.openai,
    messaging: summary.services?.uazapi?.detail || summary.messaging,
  });
}

function formatMonitorMessage(summary, kind = 'alert') {
  const openaiDetail = summary.services?.openai?.detail || 'Sem detalhe';
  const messagingDetail = summary.services?.uazapi?.detail || 'Sem detalhe';
  const databaseDetail = summary.services?.database?.detail || 'Sem detalhe';
  const calendarDetail = summary.services?.calendar?.detail || 'Sem detalhe';

  if (kind === 'recovery') {
    return [
      '✅ RECUPERADO: Sofia IA online',
      `OpenAI: ${formatStatusLabel(summary.openai)}`,
      `WhatsApp: ${formatStatusLabel(summary.messaging)}`,
      `Hora: ${summary.timestamp}`,
    ].join('\n');
  }

  if (kind === 'ping') {
    return [
      '🩺 PING SOFIA IA',
      `Status: ${summary.status.toUpperCase()}`,
      `OpenAI: ${formatStatusLabel(summary.openai)} - ${openaiDetail}`,
      `WhatsApp: ${formatStatusLabel(summary.messaging)} - ${messagingDetail}`,
      `Banco: ${formatStatusLabel(summary.database)} - ${databaseDetail}`,
      `Agenda: ${formatStatusLabel(summary.calendar)} - ${calendarDetail}`,
      `Hora: ${summary.timestamp}`,
    ].join('\n');
  }

  return [
    `🚨 ALERTA: SOFIA IA ${summary.status.toUpperCase()}`,
    `OpenAI: ${formatStatusLabel(summary.openai)} - ${openaiDetail}`,
    `WhatsApp: ${formatStatusLabel(summary.messaging)} - ${messagingDetail}`,
    `Banco: ${formatStatusLabel(summary.database)} - ${databaseDetail}`,
    `Agenda: ${formatStatusLabel(summary.calendar)} - ${calendarDetail}`,
    `Hora: ${summary.timestamp}`,
  ].join('\n');
}

async function sendMonitorMessage(message, sendMessage = monitorState.sendMessage) {
  const phone = getAlertPhone();

  if (!phone) {
    return { sent: false, reason: 'MONITORING_ALERT_PHONE nao configurado' };
  }

  if (typeof sendMessage !== 'function') {
    return { sent: false, reason: 'sendMessage indisponivel', phone };
  }

  try {
    await sendMessage(phone, message);
    return { sent: true, phone };
  } catch (error) {
    console.warn(`⚠️ [MONITOR] Falha ao enviar alerta para ${phone}: ${error.message}`);
    return { sent: false, reason: error.message, phone };
  }
}

async function maybeSendTransitionAlert(summary) {
  const now = Date.now();
  const previousStatus = monitorState.lastStatus;
  const alertKey = buildAlertKey(summary);
  let notification = { sent: false, reason: 'not_needed' };

  if (
    summary.status === 'error' && (
      previousStatus !== 'error' ||
      monitorState.lastAlertKey !== alertKey ||
      now - monitorState.lastAlertAt >= getAlertRepeatMs()
    )
  ) {
    notification = await sendMonitorMessage(formatMonitorMessage(summary, 'alert'));
    if (notification.sent) {
      monitorState.lastAlertAt = now;
      monitorState.lastAlertKey = alertKey;
    }
  } else if (previousStatus === 'error' && summary.status !== 'error') {
    notification = await sendMonitorMessage(formatMonitorMessage(summary, 'recovery'));
    if (notification.sent) {
      monitorState.lastAlertKey = null;
    }
  }

  monitorState.lastStatus = summary.status;
  return notification;
}

async function runMonitoringCheck(options = {}) {
  const { force = false, notify = false } = options;
  const { runHealthChecks } = require('./dashboard/dashboardApi');
  const checks = await runHealthChecks({ force });
  const summary = summarizeHealth(checks);
  monitorState.lastSummary = summary;

  let notification = { sent: false, reason: 'disabled' };
  if (notify) {
    notification = await maybeSendTransitionAlert(summary);
  }

  return { summary, checks, notification };
}

function getMonitoringSnapshot() {
  return {
    enabled: monitorState.started,
    intervalMs: getMonitorIntervalMs(),
    alertPhoneConfigured: Boolean(getAlertPhone()),
    alertPhone: getAlertPhone(),
    pingTokenConfigured: Boolean(getPingToken()),
    lastSummary: monitorState.lastSummary,
  };
}

function startMonitoring(sendMessage) {
  monitorState.sendMessage = sendMessage;

  if (monitorState.started) {
    return;
  }

  monitorState.started = true;

  const executeCheck = () => {
    runMonitoringCheck({ force: true, notify: true }).catch((error) => {
      console.warn(`⚠️ [MONITOR] Health check periodico falhou: ${error.message}`);
    });
  };

  setTimeout(executeCheck, getMonitorStartDelayMs());
  monitorState.intervalId = setInterval(executeCheck, getMonitorIntervalMs());

  console.log(
    `🩺 [MONITOR] Ativo: intervalo ${Math.round(getMonitorIntervalMs() / 1000)}s | alerta -> ${getAlertPhone()}`,
  );
}

module.exports = {
  authorizePingCommand,
  formatMonitorMessage,
  getAllowedPingPhones,
  getMonitoringSnapshot,
  getPingToken,
  parsePingCommand,
  runMonitoringCheck,
  sendMonitorMessage,
  startMonitoring,
  summarizeHealth,
};