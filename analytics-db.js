/**
 * analytics-db.js — Gerenciamento de dados analíticos no PostgreSQL
 * Cria e mantém a tabela analytics_snapshots, insere snapshots periódicos,
 * consulta histórico e calcula tendências e anomalias.
 */

'use strict';

const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    })
    : null;

// ─────────────────────────────────────────────────────────────
// INICIALIZAÇÃO — cria tabela se não existir
// ─────────────────────────────────────────────────────────────

async function init() {
    if (!pool) {
        console.warn('⚠️  [analytics-db] DATABASE_URL não configurada. Usando histórico em memória.');
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS analytics_snapshots (
                id          SERIAL PRIMARY KEY,
                captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                metrics     JSONB NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_analytics_captured_at
                ON analytics_snapshots (captured_at DESC);
        `);
        console.log('🗄️  [analytics-db] Tabela analytics_snapshots pronta.');
    } catch (err) {
        console.error('❌ [analytics-db] Falha ao criar tabela:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────
// HISTÓRICO EM MEMÓRIA (fallback quando não há PostgreSQL)
// ─────────────────────────────────────────────────────────────

const memoryHistory = [];   // máx. 8640 entradas ≈ 24h a cada 10s
const MAX_MEMORY = 8640;

// ─────────────────────────────────────────────────────────────
// INSERÇÃO DE SNAPSHOT
// ─────────────────────────────────────────────────────────────

async function insertSnapshot(metrics) {
    const entry = { captured_at: new Date().toISOString(), metrics };

    // Sempre mantém em memória para acesso rápido
    memoryHistory.push(entry);
    if (memoryHistory.length > MAX_MEMORY) memoryHistory.shift();

    if (!pool) return;

    try {
        await pool.query(
            'INSERT INTO analytics_snapshots (metrics) VALUES ($1::jsonb)',
            [JSON.stringify(metrics)]
        );
    } catch (err) {
        console.error('❌ [analytics-db] insertSnapshot:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────
// CONSULTAS DE HISTÓRICO
// ─────────────────────────────────────────────────────────────

/**
 * Retorna snapshots das últimas N horas.
 * @param {number} hours - Janela de tempo (padrão 24h)
 * @param {number} limit - Máximo de registros (padrão 360 = 1h a cada 10s)
 */
async function getHistory(hours = 24, limit = 360) {
    if (pool) {
        try {
            const res = await pool.query(
                `SELECT captured_at, metrics
                 FROM analytics_snapshots
                 WHERE captured_at >= NOW() - INTERVAL '${Math.floor(hours)} hours'
                 ORDER BY captured_at DESC
                 LIMIT $1`,
                [limit]
            );
            return res.rows.map(r => ({ captured_at: r.captured_at, metrics: r.metrics }));
        } catch (err) {
            console.error('❌ [analytics-db] getHistory:', err.message);
        }
    }

    // Fallback: memória
    const cutoff = Date.now() - hours * 3600 * 1000;
    return memoryHistory
        .filter(e => new Date(e.captured_at).getTime() >= cutoff)
        .slice(-limit)
        .reverse();
}

/**
 * Retorna o snapshot mais recente.
 */
function getLatest() {
    return memoryHistory.length > 0 ? memoryHistory[memoryHistory.length - 1] : null;
}

/**
 * Retorna série temporal de uma métrica específica (caminho com ponto).
 * Ex.: getTimeSeries('overview.totalConversations', 24)
 */
async function getTimeSeries(metricPath, hours = 24) {
    const history = await getHistory(hours, 8640);
    return history.map(entry => ({
        t: entry.captured_at,
        v: _getNestedValue(entry.metrics, metricPath),
    })).filter(p => p.v !== undefined);
}

function _getNestedValue(obj, path) {
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

// ─────────────────────────────────────────────────────────────
// TENDÊNCIAS
// ─────────────────────────────────────────────────────────────

/**
 * Calcula tendência de uma métrica comparando janelas de tempo.
 * Retorna: { direction: 'up'|'down'|'stable', delta, deltaPercent }
 */
async function getTrend(metricPath, windowMinutes = 10) {
    const history = await getHistory(1, 120); // última hora
    if (history.length < 2) return { direction: 'stable', delta: 0, deltaPercent: 0 };

    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;

    const recent = history.filter(e => now - new Date(e.captured_at).getTime() <= windowMs);
    const older  = history.filter(e => {
        const age = now - new Date(e.captured_at).getTime();
        return age > windowMs && age <= windowMs * 2;
    });

    if (recent.length === 0 || older.length === 0) return { direction: 'stable', delta: 0, deltaPercent: 0 };

    const avg = arr => arr.reduce((s, e) => s + (_getNestedValue(e.metrics, metricPath) || 0), 0) / arr.length;
    const recentAvg = avg(recent);
    const olderAvg  = avg(older);

    const delta = recentAvg - olderAvg;
    const deltaPercent = olderAvg !== 0 ? (delta / olderAvg) * 100 : 0;
    const direction = Math.abs(deltaPercent) < 2 ? 'stable' : delta > 0 ? 'up' : 'down';

    return { direction, delta: +delta.toFixed(2), deltaPercent: +deltaPercent.toFixed(1) };
}

// ─────────────────────────────────────────────────────────────
// DETECÇÃO DE ANOMALIAS
// ─────────────────────────────────────────────────────────────

/**
 * Detecta anomalias usando Z-score (desvio padrão).
 * Retorna lista de anomalias detectadas nas últimas 24h.
 */
async function detectAnomalies() {
    const anomalies = [];
    const checks = [
        { path: 'overview.avgResponseTimeMs', label: 'Latência da IA', unit: 'ms', threshold: 2.5 },
        { path: 'overview.errorRate',         label: 'Taxa de erros',  unit: '%', threshold: 2.0 },
        { path: 'overview.escalations',       label: 'Escalações',     unit: '',  threshold: 2.0 },
    ];

    for (const check of checks) {
        const series = await getTimeSeries(check.path, 24);
        if (series.length < 10) continue;

        const values = series.map(p => Number(p.v) || 0);
        const mean   = values.reduce((s, v) => s + v, 0) / values.length;
        const std    = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);

        if (std === 0) continue;

        const latest = values[values.length - 1];
        const z = (latest - mean) / std;

        if (Math.abs(z) >= check.threshold) {
            anomalies.push({
                metric:    check.path,
                label:     check.label,
                value:     latest,
                unit:      check.unit,
                mean:      +mean.toFixed(2),
                zScore:    +z.toFixed(2),
                severity:  Math.abs(z) >= 3 ? 'critical' : 'warning',
                direction: z > 0 ? 'high' : 'low',
                detectedAt: new Date().toISOString(),
            });
        }
    }

    return anomalies;
}

// ─────────────────────────────────────────────────────────────
// ESTATÍSTICAS AGREGADAS
// ─────────────────────────────────────────────────────────────

/**
 * Retorna estatísticas agregadas para um período.
 */
async function getAggregatedStats(hours = 24) {
    const history = await getHistory(hours);
    if (history.length === 0) return null;

    const extract = path => history.map(e => Number(_getNestedValue(e.metrics, path)) || 0);

    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
    const max = arr => arr.length ? Math.max(...arr) : 0;
    const min = arr => arr.length ? Math.min(...arr) : 0;

    const latencies = extract('overview.avgResponseTimeMs');
    const errors    = extract('overview.errorRate');
    const convs     = extract('overview.totalConversations');

    return {
        period: `${hours}h`,
        snapshots: history.length,
        latency: { avg: +avg(latencies).toFixed(0), max: max(latencies), min: min(latencies) },
        errorRate: { avg: +avg(errors).toFixed(2), max: max(errors), min: min(errors) },
        conversations: { avg: +avg(convs).toFixed(0), max: max(convs), min: min(convs) },
        firstSnapshot: history[history.length - 1]?.captured_at,
        lastSnapshot:  history[0]?.captured_at,
    };
}

module.exports = {
    init,
    insertSnapshot,
    getHistory,
    getLatest,
    getTimeSeries,
    getTrend,
    detectAnomalies,
    getAggregatedStats,
};
