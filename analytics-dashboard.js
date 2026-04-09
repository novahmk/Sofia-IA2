/**
 * analytics-dashboard.js — Servidor analítico independente para Sofia IA2
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Servidor HTTP nativo Node.js (sem Express) que opera como:
 *   1. Servidor de analytics em tempo real (porta ANALYTICS_PORT / 3002)
 *   2. WebSocket server para push de métricas (/ws/analytics)
 *   3. API REST para métricas e histórico
 *   4. SPA servida em GET /
 *
 * ROTAS:
 *   GET  /              → Serve analytics.html (SPA)
 *   GET  /health        → Status do serviço (JSON)
 *   GET  /api/metrics   → Métricas atuais (JSON)
 *   GET  /api/history   → Histórico das últimas 24 h (JSON)
 *   WS   /ws/analytics  → Stream de atualizações em tempo real
 *
 * VARIÁVEIS DE AMBIENTE:
 *   ANALYTICS_PORT      → Porta do servidor (padrão: 3002)
 *   SOFIA_API_URL       → URL base da API Sofia IA2
 *   ANALYTICS_API_TOKEN → JWT para autenticar nas rotas /api/dashboard/*
 *   DATABASE_URL        → PostgreSQL connection string (opcional)
 *   COLLECT_INTERVAL_MS → Intervalo de coleta em ms (padrão: 10000)
 *   MAX_HISTORY_POINTS  → Máximo de amostras em memória (padrão: 144)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http = require('http');
const fs   = require('fs');
const { WebSocketServer } = require('ws');

const analyticsService = require('./analytics-service');

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.ANALYTICS_PORT || '3002', 10);
const ANALYTICS_HTML = path.join(__dirname, 'analytics.html');

// ─────────────────────────────────────────────────────────────
// CORS HEADERS
// ─────────────────────────────────────────────────────────────

const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-cache',
};

// ─────────────────────────────────────────────────────────────
// WEBSOCKET — clientes conectados
// ─────────────────────────────────────────────────────────────

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

/**
 * Envia uma mensagem JSON para todos os clientes WebSocket conectados.
 * @param {string} type
 * @param {*}      data
 */
function wsBroadcast(type, data) {
    const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const ws of wsClients) {
        if (ws.readyState === 1 /* OPEN */) {
            try { ws.send(msg); } catch (_) { /* ignore */ }
        }
    }
}

// ─────────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    /** Envia resposta JSON */
    function json(statusCode, data) {
        res.writeHead(statusCode, CORS);
        res.end(JSON.stringify(data));
    }

    const url = req.url.split('?')[0]; // ignorar query string para roteamento

    // ── GET / → SPA ──
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        try {
            const html = fs.readFileSync(ANALYTICS_HTML, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(html);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('analytics.html não encontrado.');
        }
        return;
    }

    // ── GET /health ──
    if (req.method === 'GET' && url === '/health') {
        const svcState = analyticsService.getServiceState();
        return json(200, {
            status:       'ok',
            service:      'analytics-dashboard',
            uptime:       process.uptime(),
            startedAt:    svcState.startedAt ? new Date(svcState.startedAt).toISOString() : null,
            lastCollect:  svcState.lastCollectAt,
            collectCount: svcState.collectCount,
            errorCount:   svcState.errorCount,
            wsClients:    wsClients.size,
            apiReachable: svcState.apiReachable,
            dbReachable:  svcState.dbReachable,
        });
    }

    // ── GET /api/metrics ──
    if (req.method === 'GET' && url === '/api/metrics') {
        const metrics = analyticsService.getMetrics();
        if (!metrics) {
            return json(503, { error: 'Dados ainda não disponíveis. Aguarde o primeiro ciclo de coleta.' });
        }
        return json(200, metrics);
    }

    // ── GET /api/history ──
    if (req.method === 'GET' && url === '/api/history') {
        const history = analyticsService.getHistory();
        return json(200, history);
    }

    // ── 404 ──
    return json(404, { error: 'Rota não encontrada', path: url });
});

// ─────────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws/analytics' });

wss.on('connection', (ws, req) => {
    wsClients.add(ws);
    ws.isAlive = true;

    console.log(`📡 WS Analytics conectado (total: ${wsClients.size})`);

    // Enviar boas-vindas com estado atual
    try {
        ws.send(JSON.stringify({
            type:      'welcome',
            data:      { message: 'Conectado ao Sofia IA2 Analytics Stream', clients: wsClients.size },
            timestamp: new Date().toISOString(),
        }));

        // Enviar métricas atuais imediatamente
        const metrics = analyticsService.getMetrics();
        if (metrics) {
            ws.send(JSON.stringify({ type: 'metrics_update', data: metrics, timestamp: new Date().toISOString() }));
        }

        // Enviar histórico atual
        const history = analyticsService.getHistory();
        if (history.length) {
            ws.send(JSON.stringify({ type: 'history_update', data: history, timestamp: new Date().toISOString() }));
        }
    } catch (_) { /* ignore */ }

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
        wsClients.delete(ws);
        console.log(`📡 WS Analytics desconectado (total: ${wsClients.size})`);
    });

    ws.on('error', () => {
        wsClients.delete(ws);
    });
});

// Heartbeat a cada 30 s
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
}, 30000);

// ─────────────────────────────────────────────────────────────
// INTEGRAÇÃO COM O SERVIÇO DE ANALYTICS
// ─────────────────────────────────────────────────────────────

// A cada ciclo de coleta, fazer broadcast para todos os clientes WS
analyticsService.onUpdate((metricsData) => {
    wsBroadcast('metrics_update', metricsData);
    wsBroadcast('history_update', analyticsService.getHistory());
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║       Sofia IA2 — Analytics Dashboard                ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  HTTP  → http://localhost:${PORT}                       ║`);
    console.log(`║  WS    → ws://localhost:${PORT}/ws/analytics            ║`);
    console.log(`║  API   → ${process.env.SOFIA_API_URL || 'https://sofia-ia2-production.up.railway.app'}`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    // Iniciar coleta de dados
    analyticsService.start();
});

// ─────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
    console.log(`\n🛑 ${signal} recebido — encerrando Analytics Dashboard…`);
    await analyticsService.stop();
    server.close(() => {
        console.log('✅ Servidor encerrado.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});
