/**
 * analytics-dashboard.js — Servidor de Analytics Separado
 * ═══════════════════════════════════════════════════════════════
 *
 * Serviço independente que:
 *   1. Conecta ao PostgreSQL via DATABASE_URL
 *   2. Faz requisições à API Sofia IA2 a cada 10 segundos
 *   3. Armazena snapshots de métricas na tabela analytics_snapshots
 *   4. Expõe endpoints REST com dados agregados
 *   5. WebSocket para push de atualizações em tempo real
 *   6. Serve interface web com gráficos (Chart.js)
 *
 * Porta: process.env.ANALYTICS_PORT || 4000
 *
 * Endpoints:
 *   GET  /                        → Serve analytics-ui.html
 *   GET  /health                  → Health check do serviço de analytics
 *   GET  /api/snapshot            → Snapshot mais recente
 *   GET  /api/history?hours=24    → Histórico de snapshots
 *   GET  /api/timeseries?metric=X → Série temporal de uma métrica
 *   GET  /api/trends              → Tendências das métricas principais
 *   GET  /api/anomalies           → Anomalias detectadas
 *   GET  /api/stats?hours=24      → Estatísticas agregadas
 *   WS   /ws                      → WebSocket para push em tempo real
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const analyticsDb  = require('./analytics-db');
const analyticsApi = require('./analytics-api');

const PORT = parseInt(process.env.ANALYTICS_PORT || process.env.PORT || '4000', 10);
const COLLECT_INTERVAL_MS = 10_000; // 10 segundos

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────

let latestSnapshot = null;
let collectErrors  = 0;
let collectTotal   = 0;
const startedAt    = new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────

let wss = null;
const wsClients = new Set();

function broadcastSnapshot(snapshot) {
    if (!wss) return;
    const msg = JSON.stringify({ type: 'snapshot', data: snapshot, ts: new Date().toISOString() });
    for (const ws of wsClients) {
        if (ws.readyState === 1) {
            try { ws.send(msg); } catch (_) { /* ignore */ }
        }
    }
}

function broadcastAnomalies(anomalies) {
    if (!wss || anomalies.length === 0) return;
    const msg = JSON.stringify({ type: 'anomalies', data: anomalies, ts: new Date().toISOString() });
    for (const ws of wsClients) {
        if (ws.readyState === 1) {
            try { ws.send(msg); } catch (_) { /* ignore */ }
        }
    }
}

// ─────────────────────────────────────────────────────────────
// LOOP DE COLETA (a cada 10s)
// ─────────────────────────────────────────────────────────────

async function collect() {
    collectTotal++;
    try {
        const snapshot = await analyticsApi.collectSnapshot();
        latestSnapshot = snapshot;

        await analyticsDb.insertSnapshot(snapshot);
        broadcastSnapshot(snapshot);

        // Detecta anomalias a cada 6 coletas (≈ 1 minuto)
        if (collectTotal % 6 === 0) {
            const anomalies = await analyticsDb.detectAnomalies();
            if (anomalies.length > 0) {
                console.warn(`⚠️  [analytics] ${anomalies.length} anomalia(s) detectada(s)`);
                broadcastAnomalies(anomalies);
            }
        }

        if (collectTotal % 30 === 0) {
            console.log(`📊 [analytics] Coleta #${collectTotal} | API: ${snapshot.apiReachable ? '✅' : '❌'} | Conversas: ${snapshot.overview.totalConversations} | Latência: ${snapshot.overview.avgResponseTimeMs}ms`);
        }
    } catch (err) {
        collectErrors++;
        console.error(`❌ [analytics] Erro na coleta #${collectTotal}:`, err.message);
    }
}

// ─────────────────────────────────────────────────────────────
// UTILITÁRIOS HTTP
// ─────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-cache',
    });
    res.end(body);
}

function sendHtml(res, filePath) {
    try {
        const html = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('analytics-ui.html não encontrado');
    }
}

function parseQuery(url) {
    try {
        return Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries());
    } catch (_) {
        return {};
    }
}

// ─────────────────────────────────────────────────────────────
// SERVIDOR HTTP
// ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const url    = req.url.split('?')[0];
    const method = req.method;
    const query  = parseQuery(req.url);

    // CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
    }

    // ── GET / → Dashboard UI ──────────────────────────────────
    if (method === 'GET' && (url === '/' || url === '/dashboard')) {
        return sendHtml(res, path.join(__dirname, 'analytics-ui.html'));
    }

    // ── GET /health ───────────────────────────────────────────
    if (method === 'GET' && url === '/health') {
        return sendJson(res, 200, {
            status:       'ok',
            service:      'sofia-analytics-dashboard',
            startedAt,
            uptime:       Math.floor(process.uptime()),
            collectTotal,
            collectErrors,
            lastCollect:  latestSnapshot?.collectedAt || null,
            apiReachable: latestSnapshot?.apiReachable || false,
        });
    }

    // ── GET /api/snapshot ─────────────────────────────────────
    if (method === 'GET' && url === '/api/snapshot') {
        if (!latestSnapshot) {
            return sendJson(res, 503, { error: 'Nenhum snapshot disponível ainda. Aguarde 10 segundos.' });
        }
        return sendJson(res, 200, { snapshot: latestSnapshot, collectTotal, collectErrors });
    }

    // ── GET /api/history ──────────────────────────────────────
    if (method === 'GET' && url === '/api/history') {
        const hours = Math.min(parseInt(query.hours || '24', 10), 168); // máx 7 dias
        const limit = Math.min(parseInt(query.limit || '360', 10), 8640);
        try {
            const history = await analyticsDb.getHistory(hours, limit);
            return sendJson(res, 200, { history, count: history.length, hours });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // ── GET /api/timeseries ───────────────────────────────────
    if (method === 'GET' && url === '/api/timeseries') {
        const metric = query.metric || 'overview.totalConversations';
        const hours  = Math.min(parseInt(query.hours || '24', 10), 168);
        try {
            const series = await analyticsDb.getTimeSeries(metric, hours);
            return sendJson(res, 200, { metric, series, count: series.length, hours });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // ── GET /api/trends ───────────────────────────────────────
    if (method === 'GET' && url === '/api/trends') {
        try {
            const [latency, errors, conversations, appointments] = await Promise.all([
                analyticsDb.getTrend('overview.avgResponseTimeMs', 10),
                analyticsDb.getTrend('overview.errorRate', 10),
                analyticsDb.getTrend('overview.totalConversations', 10),
                analyticsDb.getTrend('overview.totalAppointments', 10),
            ]);
            return sendJson(res, 200, {
                trends: { latency, errors, conversations, appointments },
                calculatedAt: new Date().toISOString(),
            });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // ── GET /api/anomalies ────────────────────────────────────
    if (method === 'GET' && url === '/api/anomalies') {
        try {
            const anomalies = await analyticsDb.detectAnomalies();
            return sendJson(res, 200, { anomalies, count: anomalies.length, detectedAt: new Date().toISOString() });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // ── GET /api/stats ────────────────────────────────────────
    if (method === 'GET' && url === '/api/stats') {
        const hours = Math.min(parseInt(query.hours || '24', 10), 168);
        try {
            const stats = await analyticsDb.getAggregatedStats(hours);
            return sendJson(res, 200, { stats, hours });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // ── 404 ───────────────────────────────────────────────────
    sendJson(res, 404, { error: 'Endpoint não encontrado', path: url });
});

// ─────────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────────

function initWebSocket() {
    wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        wsClients.add(ws);
        console.log(`🔌 [analytics-ws] Cliente conectado (total: ${wsClients.size})`);

        // Envia snapshot imediato ao conectar
        if (latestSnapshot) {
            try {
                ws.send(JSON.stringify({ type: 'snapshot', data: latestSnapshot, ts: new Date().toISOString() }));
            } catch (_) { /* ignore */ }
        }

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('close', () => {
            wsClients.delete(ws);
            console.log(`🔌 [analytics-ws] Cliente desconectado (total: ${wsClients.size})`);
        });

        ws.on('error', () => { wsClients.delete(ws); });
    });

    // Heartbeat a cada 30s
    setInterval(() => {
        for (const ws of wsClients) {
            if (!ws.isAlive) {
                wsClients.delete(ws);
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30_000);

    console.log('🔌 [analytics-ws] WebSocket disponível em /ws');
}

// ─────────────────────────────────────────────────────────────
// INICIALIZAÇÃO
// ─────────────────────────────────────────────────────────────

async function start() {
    console.log('🚀 [analytics] Iniciando Sofia Analytics Dashboard...');

    // 1. Inicializa banco de dados (cria tabela se necessário)
    await analyticsDb.init();

    // 2. Primeira coleta imediata
    await collect();

    // 3. Loop de coleta a cada 10 segundos
    setInterval(collect, COLLECT_INTERVAL_MS);

    // 4. Inicia WebSocket
    initWebSocket();

    // 5. Inicia servidor HTTP
    server.listen(PORT, () => {
        console.log(`✅ [analytics] Dashboard disponível em http://localhost:${PORT}`);
        console.log(`📊 [analytics] Coletando métricas a cada ${COLLECT_INTERVAL_MS / 1000}s`);
        console.log(`🔗 [analytics] API Sofia: ${process.env.SOFIA_API_URL || 'https://sofia-ia2-production.up.railway.app'}`);
    });
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 [analytics] Encerrando...');
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('🛑 [analytics] Encerrando...');
    server.close(() => process.exit(0));
});

start().catch(err => {
    console.error('❌ [analytics] Falha ao iniciar:', err.message);
    process.exit(1);
});
