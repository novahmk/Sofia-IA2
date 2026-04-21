'use strict';
/**
 * responseCache.js — Cache in-memory de respostas da IA
 *
 * Problema: chamadas OpenAI levam 2-5s. Perguntas repetidas (preço, horário,
 * endereço) chegam dezenas de vezes por dia com texto idêntico ou muito similar.
 *
 * Solução: cache LRU simples. Cache key = hash SHA-1 do texto normalizado.
 * TTL padrão: 10 min (perguntas factuais não mudam). Cache varia por ETAPA
 * DO FUNIL do lead — mesmo texto em etapas diferentes pode ter resposta diferente.
 *
 * Se REDIS_URL estiver configurado, persiste no Redis (compartilhado entre pods).
 * Caso contrário, cache in-memory (single pod, reinicia ao deploy).
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = parseInt(process.env.RESPONSE_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
const MAX_ENTRIES    = parseInt(process.env.RESPONSE_CACHE_MAX    || '500', 10);

// Entrada de cache: { response, ts, hits }
const _cache = new Map();

// ── Em breve: Redis backend (quando REDIS_URL disponível) ──
let _redis = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    _redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    _redis.connect().catch(() => { _redis = null; });
    console.log('📋 ResponseCache: Redis conectado');
  } catch (_) {
    console.warn('📋 ResponseCache: ioredis não instalado, usando in-memory');
  }
}

function _normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // sem acentos
    .replace(/[^\w\s]/g, ' ')          // sem pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

function _makeKey(text, etapa) {
  const normalized = _normalize(text);
  return crypto.createHash('sha1').update(`${etapa}|${normalized}`).digest('hex');
}

function _evictOldest() {
  // Remove a entrada com menor timestamp (mais antiga)
  let oldestKey = null, oldestTs = Infinity;
  for (const [k, v] of _cache) {
    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey) _cache.delete(oldestKey);
}

/**
 * Obtém resposta do cache.
 * @param {string} text - mensagem original do usuário
 * @param {string} etapa - etapa_funil do lead (ex: 'novo', 'qualificado')
 * @returns {string|null}
 */
async function get(text, etapa = 'novo') {
  const key = _makeKey(text, etapa);

  // Tenta Redis primeiro
  if (_redis) {
    try {
      const val = await _redis.get(`rc:${key}`);
      if (val) return val;
    } catch (_) {}
  }

  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > DEFAULT_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  entry.hits++;
  return entry.response;
}

/**
 * Salva resposta no cache.
 * @param {string} text - mensagem original
 * @param {string} etapa
 * @param {string} response - resposta gerada pela IA
 * @param {number} [ttlMs] - TTL customizado em ms
 */
async function set(text, etapa = 'novo', response, ttlMs = DEFAULT_TTL_MS) {
  const key = _makeKey(text, etapa);

  // Redis
  if (_redis) {
    try {
      await _redis.set(`rc:${key}`, response, 'PX', ttlMs);
    } catch (_) {}
  }

  if (_cache.size >= MAX_ENTRIES) _evictOldest();
  _cache.set(key, { response, ts: Date.now(), hits: 0 });
}

/**
 * Invalida todas as entradas de um usuário (ex: ao mudar etapa do funil).
 * Como a key não inclui phone, isto é um wrapper para invalidação futura.
 */
function invalidate(/* phone */) {
  // No-op por ora: TTL garante expiração natural.
  // Com Redis poderíamos usar SCAN + DEL por padrão.
}

/**
 * Estatísticas do cache (para o dashboard).
 */
function getStats() {
  let totalHits = 0;
  let expired = 0;
  const now = Date.now();
  for (const v of _cache.values()) {
    totalHits += v.hits;
    if (now - v.ts > DEFAULT_TTL_MS) expired++;
  }
  return {
    entries: _cache.size,
    maxEntries: MAX_ENTRIES,
    totalHits,
    expired,
    backendRedis: !!_redis,
    ttlMinutes: Math.round(DEFAULT_TTL_MS / 60000),
  };
}

module.exports = { get, set, invalidate, getStats };
