'use strict';
/**
 * redisStateAdapter.js — Adapter para estado in-memory ou Redis
 *
 * Problema: chatHistories e customerIntents são objetos globais em ai.js.
 * Num deploy com múltiplos pods (Railway horizontal scaling), cada pod tem
 * sua cópia separada e o histórico se perde entre pods.
 *
 * Solução: interface idêntica ao objeto JS ({get, set, has, delete}), mas
 * com backend Redis quando REDIS_URL estiver configurado. Sem Redis, usa
 * Map in-memory (comportamento atual, sem regressão).
 *
 * Uso (em ai.js, substitui o objeto literal):
 *   const chatHistories = require('./redisStateAdapter').createAdapter('hist', 3600);
 *   chatHistories.set(userId, [...])  // async — deve ser awaited
 *   chatHistories.get(userId)          // async — deve ser awaited
 *
 * NOTA: Para compatibilidade com o ai.js atual (síncrono), este adapter
 * expõe também getSync/setSync que funcionam sobre o Map local e propagam
 * para Redis em background (eventual consistency).
 */

const REDIS_URL = process.env.REDIS_URL;

let _redis = null;
if (REDIS_URL) {
  try {
    const Redis = require('ioredis');
    _redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      reconnectOnError: () => true,
    });
    _redis.connect()
      .then(() => console.log('🗄️  RedisStateAdapter: conectado'))
      .catch((e) => {
        console.warn('⚠️  RedisStateAdapter: Redis indisponível, usando in-memory:', e.message);
        _redis = null;
      });
  } catch (_) {
    console.warn('⚠️  RedisStateAdapter: ioredis não instalado, usando in-memory');
  }
}

/**
 * Cria um adapter de estado.
 * @param {string} namespace - prefixo das chaves no Redis (ex: 'hist', 'intent')
 * @param {number} ttlSeconds - TTL das chaves no Redis (default: 24h)
 */
function createAdapter(namespace, ttlSeconds = 86400) {
  // Cache local: sempre disponível, mesmo com Redis
  const _local = new Map();

  function _redisKey(id) {
    return `sofia:${namespace}:${id}`;
  }

  /**
   * Obtém valor. Retorna Promise<value> (ou null se não existir).
   */
  async function get(id) {
    // Local primeiro (mais rápido)
    if (_local.has(id)) return _local.get(id);

    if (_redis) {
      try {
        const raw = await _redis.get(_redisKey(id));
        if (raw) {
          const val = JSON.parse(raw);
          _local.set(id, val);  // warm local cache
          return val;
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * Síncrono (retorna do cache local imediatamente).
   * Redis é atualizado em background.
   */
  function getSync(id) {
    return _local.get(id) ?? null;
  }

  /**
   * Define valor. Persiste no Redis em background.
   */
  async function set(id, value) {
    _local.set(id, value);
    if (_redis) {
      try {
        await _redis.set(_redisKey(id), JSON.stringify(value), 'EX', ttlSeconds);
      } catch (_) {}
    }
  }

  /**
   * Síncrono — atualiza local e dispara Redis em background.
   */
  function setSync(id, value) {
    _local.set(id, value);
    if (_redis) {
      _redis.set(_redisKey(id), JSON.stringify(value), 'EX', ttlSeconds).catch(() => {});
    }
  }

  function has(id) {
    return _local.has(id);
  }

  function del(id) {
    _local.delete(id);
    if (_redis) {
      _redis.del(_redisKey(id)).catch(() => {});
    }
  }

  function size() {
    return _local.size;
  }

  return { get, getSync, set, setSync, has, delete: del, size };
}

/**
 * Instâncias pré-criadas para ai.js (compatíveis com o uso atual via setSync/getSync).
 * TTL de 6h para históricos de chat, 24h para intenções.
 */
const chatHistoriesAdapter   = createAdapter('hist',   6 * 3600);
const customerIntentsAdapter = createAdapter('intent', 24 * 3600);

function getStatus() {
  return {
    redisConnected: !!_redis,
    chatHistoriesLocal: chatHistoriesAdapter.size(),
    customerIntentsLocal: customerIntentsAdapter.size(),
  };
}

module.exports = { createAdapter, chatHistoriesAdapter, customerIntentsAdapter, getStatus };
