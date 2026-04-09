/**
 * analytics-service.js — Serviço de coleta e análise de dados em tempo real
 *
 * Responsabilidades:
 *   - Conectar com a API Sofia IA2 (REST)
 *   - Conectar com PostgreSQL para dados históricos
 *   - Coletar dados a cada 10 segundos
 *   - Calcular métricas (média, máximo, mínimo, tendência)
 *   - Armazenar histórico em memória (últimas 144 amostras = 24 h a cada 10 s)
 *   - Emitir eventos via callback para o servidor WebSocket
 */

'use strict';

const https = require('https');
const http  = require('http');
const { Pool } = require('pg');
const {
    mean,
    summarize,
    detectTrend,
    percentChange,
    generateAlerts,
} = require('./metrics-calculator');

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────

const SOFIA_API_BASE  = process.env.SOFIA_API_URL || 'https://sofia-ia2-production.up.railway.app';
const SOFIA_API_TOKEN = process.env.ANALYTICS_API_TOKEN || process.env.JWT_TOKEN || '';
const COLLECT_INTERVAL_MS = parseInt(process.env.COLLECT_INTERVAL_MS || '10000', 10);
const MAX_HISTORY_POINTS  = parseInt(process.env.MAX_HISTORY_POINTS  || '144',   10); // 24 h × 6 amostras/min

// ─────────────────────────────────────────────────────────────
// POOL POSTGRESQL (opcional — graceful degradation)
// ─────────────────────────────────────────────────────────────

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const pgPool = hasDatabaseUrl
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    })
    : null;

async function pgQuery(text, params = []) {
    if (!pgPool) return null;
    const client = await pgPool.connect();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────────────────────

/** @type {Array<{ timestamp: string, raw: Object, metrics: Object }>} */
const history = [];

/** Métricas calculadas mais recentes */
let currentMetrics = null;

/** Alertas ativos */
let currentAlerts = [];

/** Callbacks registrados para receber atualizações */
const listeners = new Set();

/** Timer do intervalo de coleta */
let collectTimer = null;

/** Contadores de estado do serviço */
const serviceState = {
    startedAt: null,
    lastCollectAt: null,
    collectCount: 0,
    errorCount: 0,
    apiReachable: false,
    dbReachable: false,
};

// ─────────────────────────────────────────────────────────────
// UTILITÁRIOS HTTP
// ─────────────────────────────────────────────────────────────

/**
 * Faz uma requisição HTTP/HTTPS e retorna { ok, statusCode, body, latencyMs }.
 * @param {string} url
 * @param {{ method?: string, headers?: Object, timeoutMs?: number }} [opts]
 */
function fetchUrl(url, opts = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: opts.method || 'GET',
            headers: opts.headers || {},
        };

        const req = lib.request(options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                const latencyMs = Date.now() - start;
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode, body, latencyMs });
            });
        });

        req.on('error', (err) => {
            resolve({ ok: false, statusCode: 0, body: '', latencyMs: Date.now() - start, error: err.message });
        });

        req.setTimeout(opts.timeoutMs || 8000, () => {
            req.destroy();
            resolve({ ok: false, statusCode: 0, body: '', latencyMs: opts.timeoutMs || 8000, error: 'Timeout' });
        });

        req.end();
    });
}

/**
 * Busca um endpoint da API Sofia IA2 e retorna o JSON parseado.
 * @param {string} path  — ex: '/api/dashboard/overview'
 * @returns {Promise<Object|null>}
 */
async function fetchSofiaApi(path) {
    const url = `${SOFIA_API_BASE}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (SOFIA_API_TOKEN) headers['Authorization'] = `Bearer ${SOFIA_API_TOKEN}`;

    try {
        const res = await fetchUrl(url, { headers, timeoutMs: 8000 });
        if (!res.ok) {
            console.warn(`[analytics-service] API ${path} → HTTP ${res.statusCode}`);
            return null;
        }
        return JSON.parse(res.body);
    } catch (err) {
        console.warn(`[analytics-service] Falha ao buscar ${path}: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// COLETA DE DADOS
// ─────────────────────────────────────────────────────────────

/**
 * Busca dados históricos do PostgreSQL (últimas 24 h de conversas).
 * @returns {Promise<{ messageCount: number, appointmentCount: number, avgLatencyMs: number }>}
 */
async function fetchDbHistory() {
    if (!pgPool) return { messageCount: 0, appointmentCount: 0, avgLatencyMs: 0 };

    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const [msgRes, apptRes] = await Promise.all([
            pgQuery(
                `SELECT COUNT(*) AS cnt FROM conversations WHERE created_at >= $1`,
                [since]
            ).catch(() => null),
            pgQuery(
                `SELECT COUNT(*) AS cnt FROM appointments WHERE created_at >= $1`,
                [since]
            ).catch(() => null),
        ]);

        serviceState.dbReachable = true;

        return {
            messageCount:    parseInt(msgRes?.rows?.[0]?.cnt  || '0', 10),
            appointmentCount: parseInt(apptRes?.rows?.[0]?.cnt || '0', 10),
            avgLatencyMs: 0,
        };
    } catch (err) {
        serviceState.dbReachable = false;
        console.warn(`[analytics-service] DB query falhou: ${err.message}`);
        return { messageCount: 0, appointmentCount: 0, avgLatencyMs: 0 };
    }
}

/**
 * Executa um ciclo completo de coleta: API + DB → calcula métricas → armazena.
 */
async function collect() {
    const collectStart = Date.now();

    // ── 1. Buscar dados da API Sofia IA2 em paralelo ──
    const [overview, kpis, system] = await Promise.all([
        fetchSofiaApi('/api/dashboard/overview'),
        fetchSofiaApi('/api/dashboard/kpis'),
        fetchSofiaApi('/api/dashboard/system'),
    ]);

    serviceState.apiReachable = Boolean(overview || kpis || system);

    // ── 2. Buscar dados históricos do PostgreSQL ──
    const dbData = await fetchDbHistory();

    // ── 3. Montar snapshot bruto ──
    const raw = {
        timestamp: new Date().toISOString(),
        overview:  overview  || {},
        kpis:      kpis      || {},
        system:    system    || {},
        db:        dbData,
    };

    // ── 4. Extrair métricas normalizadas ──
    const metrics = {
        timestamp:          raw.timestamp,
        // Conversas
        conversationsToday: overview?.conversationsToday  || 0,
        activeNow:          overview?.activeNow           || 0,
        leadsToday:         overview?.leadsToday          || 0,
        // Agendamentos
        appointmentsToday:  overview?.appointmentsToday   || 0,
        bookingRate:        overview?.bookingRate          || 0,
        // Performance
        avgResponseTimeMs:  parseFloat(overview?.avgResponseTime || kpis?.avgResponseTime || '0') * 1000,
        avgResponseTimeSec: parseFloat(overview?.avgResponseTime || kpis?.avgResponseTime || '0'),
        uptime:             overview?.uptime              || '—',
        // Erros
        errorRate:          parseFloat(system?.errorRate  || '0'),
        selfHealingEvents:  system?.selfHealingEvents     || 0,
        // Conversão
        conversionRate:     overview?.conversionRate      || 0,
        // Mensagens
        totalMessages:      overview?.totalMessages       || kpis?.totalMessages7d || 0,
        // DB histórico
        dbMessages24h:      dbData.messageCount,
        dbAppointments24h:  dbData.appointmentCount,
        // Latência de coleta
        collectLatencyMs:   Date.now() - collectStart,
    };

    // ── 5. Armazenar no histórico (ring buffer) ──
    history.push({ timestamp: raw.timestamp, raw, metrics });
    if (history.length > MAX_HISTORY_POINTS) {
        history.splice(0, history.length - MAX_HISTORY_POINTS);
    }

    // ── 6. Calcular métricas derivadas (tendência, variação) ──
    const metricKeys = [
        'conversationsToday', 'avgResponseTimeMs', 'errorRate',
        'conversionRate', 'totalMessages', 'appointmentsToday',
    ];

    const derived = {};
    for (const key of metricKeys) {
        const series = history.map(h => h.metrics[key]).filter(v => typeof v === 'number');
        const stats  = summarize(series);
        const trend  = detectTrend(series);
        const prev   = series.length >= 2 ? series[series.length - 2] : series[0] || 0;
        const curr   = metrics[key];

        derived[key] = {
            current: curr,
            ...stats,
            trend: trend.direction,
            trendSlope: trend.slope,
            changePercent: percentChange(prev, curr),
        };
    }

    // ── 7. Gerar alertas ──
    currentAlerts = generateAlerts(metrics);

    // ── 8. Publicar resultado ──
    currentMetrics = {
        timestamp:    raw.timestamp,
        metrics,
        derived,
        alerts:       currentAlerts,
        historySize:  history.length,
        service: {
            apiReachable: serviceState.apiReachable,
            dbReachable:  serviceState.dbReachable,
            collectCount: ++serviceState.collectCount,
            errorCount:   serviceState.errorCount,
            uptime:       serviceState.startedAt ? Math.floor((Date.now() - serviceState.startedAt) / 1000) : 0,
        },
    };

    serviceState.lastCollectAt = raw.timestamp;

    // ── 9. Notificar listeners ──
    for (const fn of listeners) {
        try { fn(currentMetrics); } catch (e) { /* ignore listener errors */ }
    }

    return currentMetrics;
}

// ─────────────────────────────────────────────────────────────
// API PÚBLICA DO SERVIÇO
// ─────────────────────────────────────────────────────────────

/**
 * Inicia o loop de coleta.
 */
function start() {
    if (collectTimer) return; // já iniciado
    serviceState.startedAt = Date.now();
    console.log(`📊 Analytics Service iniciado — coleta a cada ${COLLECT_INTERVAL_MS / 1000}s`);
    console.log(`   API Sofia: ${SOFIA_API_BASE}`);
    console.log(`   PostgreSQL: ${hasDatabaseUrl ? 'configurado' : 'não configurado (modo memória)'}`);

    // Primeira coleta imediata
    collect().catch(err => {
        serviceState.errorCount++;
        console.error(`[analytics-service] Erro na coleta inicial: ${err.message}`);
    });

    collectTimer = setInterval(() => {
        collect().catch(err => {
            serviceState.errorCount++;
            console.error(`[analytics-service] Erro na coleta: ${err.message}`);
        });
    }, COLLECT_INTERVAL_MS);
}

/**
 * Para o loop de coleta e fecha o pool PostgreSQL.
 */
async function stop() {
    if (collectTimer) {
        clearInterval(collectTimer);
        collectTimer = null;
    }
    if (pgPool) {
        await pgPool.end().catch(() => {});
    }
    console.log('📊 Analytics Service parado.');
}

/**
 * Registra um listener que será chamado a cada ciclo de coleta.
 * @param {Function} fn  — recebe o objeto currentMetrics
 * @returns {Function}   — função para remover o listener
 */
function onUpdate(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Retorna as métricas calculadas mais recentes.
 * @returns {Object|null}
 */
function getMetrics() {
    return currentMetrics;
}

/**
 * Retorna o histórico completo (últimas MAX_HISTORY_POINTS amostras).
 * @returns {Array}
 */
function getHistory() {
    return history.slice();
}

/**
 * Retorna os alertas ativos.
 * @returns {Array}
 */
function getAlerts() {
    return currentAlerts.slice();
}

/**
 * Retorna o estado interno do serviço.
 * @returns {Object}
 */
function getServiceState() {
    return { ...serviceState };
}

module.exports = {
    start,
    stop,
    onUpdate,
    getMetrics,
    getHistory,
    getAlerts,
    getServiceState,
};
