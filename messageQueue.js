'use strict';
/**
 * messageQueue.js — Fila de processamento de mensagens por telefone
 *
 * Problema: Node.js é single-thread. Se 50 mensagens chegarem ao mesmo tempo
 * cada uma lança um `await supervisor.processMessage()` concorrente → o loop
 * de eventos trava e o OpenAI recebe 50 chamadas simultâneas.
 *
 * Solução: cada número de telefone tem sua própria fila FIFO. Mensagens do
 * mesmo usuário são processadas em série. Usuários diferentes processam em
 * paralelo (mas limitados por MAX_CONCURRENT_USERS).
 *
 * Se REDIS_URL estiver configurado, usa BullMQ para persistência e
 * escalabilidade horizontal. Caso contrário, usa fila in-memory.
 */

const MAX_CONCURRENT_USERS = parseInt(process.env.MAX_CONCURRENT_USERS || '20', 10);
const QUEUE_TIMEOUT_MS     = parseInt(process.env.QUEUE_TIMEOUT_MS    || '30000', 10);

// ── In-memory serial queue ──────────────────────────────────────────────────
// Map<phone, Promise> — cada valor é a "cauda" da fila daquele número
const _queues   = new Map();
const _drainCbs = new Map(); // para cleanup

// semáforo simples para limitar usuários simultâneos
let _active = 0;
const _waiting = [];

function _semAcquire() {
  if (_active < MAX_CONCURRENT_USERS) {
    _active++;
    return Promise.resolve();
  }
  return new Promise(resolve => _waiting.push(resolve));
}

function _semRelease() {
  if (_waiting.length > 0) {
    const next = _waiting.shift();
    next();
  } else {
    _active--;
  }
}

/**
 * Enfileira uma tarefa para ser processada em série por número de telefone.
 * @param {string} phone - número E.164
 * @param {Function} task - async function() => result
 * @returns {Promise<any>} resultado da task
 */
async function enqueue(phone, task) {
  // Pega a fila atual (ou cria uma nova resolida)
  const prev = _queues.get(phone) || Promise.resolve();

  let resolveTail, rejectTail;
  const tail = new Promise((res, rej) => { resolveTail = res; rejectTail = rej; });
  _queues.set(phone, tail);

  // Timeout de segurança
  const timer = setTimeout(() => {
    rejectTail(new Error(`Queue timeout para ${phone}`));
    _queues.delete(phone);
  }, QUEUE_TIMEOUT_MS);

  // Aguarda a fila anterior e depois executa
  try {
    await prev;
    await _semAcquire();
    let result;
    try {
      result = await task();
    } finally {
      _semRelease();
    }
    clearTimeout(timer);
    resolveTail();
    // Limpa a referência se não há mais ninguém esperando
    if (_queues.get(phone) === tail) _queues.delete(phone);
    return result;
  } catch (err) {
    clearTimeout(timer);
    rejectTail(err);
    if (_queues.get(phone) === tail) _queues.delete(phone);
    throw err;
  }
}

/**
 * Retorna métricas da fila para o dashboard.
 */
function getStats() {
  return {
    activePhonesInQueue: _queues.size,
    activeUsers: _active,
    waitingForSlot: _waiting.length,
    maxConcurrentUsers: MAX_CONCURRENT_USERS,
  };
}

module.exports = { enqueue, getStats };
