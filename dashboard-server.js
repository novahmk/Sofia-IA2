/**
 * SOFIA IA — Dashboard Server
 * ═══════════════════════════════════════════════════════════════
 *
 * Servidor HTTP dedicado ao dashboard administrativo.
 * Opera na porta 3001 (DASHBOARD_PORT) e:
 *   1. Serve dashboard.html como SPA (Single Page Application)
 *   2. Faz proxy de /api/* → http://localhost:3000/api/*
 *   3. Faz proxy de /ws/*  → ws://localhost:3000/ws/*
 *   4. Compressão gzip nas respostas estáticas
 *   5. Headers CORS para desenvolvimento local
 *   6. Health check em /health
 *
 * PORTA:
 *   process.env.DASHBOARD_PORT || 3001
 *
 * DEPENDÊNCIAS:
 *   Apenas módulos nativos do Node.js (http, https, fs, path, zlib, url, net)
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http  = require('http');
const fs    = require('fs');
const zlib  = require('zlib');
const url   = require('url');
const net   = require('net');

// ─── Configuração ────────────────────────────────────────────────────────────

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
const API_HOST       = process.env.API_HOST || 'localhost';
const API_PORT       = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10);
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');

// ─── Utilitários ─────────────────────────────────────────────────────────────

/**
 * Adiciona headers CORS à resposta.
 * @param {http.ServerResponse} res
 * @param {http.IncomingMessage} req
 */
function setCorsHeaders(res, req) {
    const origin = (req && req.headers && req.headers.origin) || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Envia uma resposta JSON simples.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

/**
 * Verifica se o cliente aceita compressão gzip.
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function acceptsGzip(req) {
    const ae = req.headers['accept-encoding'] || '';
    return ae.includes('gzip');
}

/**
 * Serve o arquivo dashboard.html com compressão gzip opcional.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function serveDashboard(req, res) {
    fs.readFile(DASHBOARD_HTML, (err, data) => {
        if (err) {
            console.error('[dashboard-server] Erro ao ler dashboard.html:', err.message);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Erro interno: dashboard.html não encontrado.');
            return;
        }

        const headers = {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Content-Type-Options': 'nosniff',
        };

        if (acceptsGzip(req)) {
            zlib.gzip(data, (gzipErr, compressed) => {
                if (gzipErr) {
                    // Fallback sem compressão
                    headers['Content-Length'] = data.length;
                    res.writeHead(200, headers);
                    res.end(data);
                    return;
                }
                headers['Content-Encoding'] = 'gzip';
                headers['Content-Length']   = compressed.length;
                res.writeHead(200, headers);
                res.end(compressed);
            });
        } else {
            headers['Content-Length'] = data.length;
            res.writeHead(200, headers);
            res.end(data);
        }
    });
}

/**
 * Faz proxy de uma requisição HTTP para o servidor principal (porta 3000).
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} targetPath  Caminho completo a ser encaminhado (ex: /api/dashboard/overview)
 */
function proxyHttp(req, res, targetPath) {
    const options = {
        hostname: API_HOST,
        port:     API_PORT,
        path:     targetPath,
        method:   req.method,
        headers:  Object.assign({}, req.headers, {
            host: `${API_HOST}:${API_PORT}`,
        }),
    };

    const proxyReq = http.request(options, (proxyRes) => {
        // Repassa status e headers da resposta upstream
        const responseHeaders = Object.assign({}, proxyRes.headers);

        // Remove headers de encoding para evitar conflito com proxy
        delete responseHeaders['transfer-encoding'];

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error(`[dashboard-server] Erro no proxy HTTP para ${targetPath}:`, err.message);
        if (!res.headersSent) {
            sendJson(res, 502, {
                error: 'Bad Gateway',
                message: 'Não foi possível conectar ao servidor principal.',
                detail: err.message,
            });
        }
    });

    // Encaminha o body da requisição original
    req.pipe(proxyReq, { end: true });
}

// ─── Servidor HTTP ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url || '/', true);
    const pathname  = parsedUrl.pathname || '/';

    // CORS preflight
    setCorsHeaders(res, req);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ── Health check ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
            status:    'ok',
            service:   'dashboard-server',
            port:      DASHBOARD_PORT,
            upstream:  `http://${API_HOST}:${API_PORT}`,
            timestamp: new Date().toISOString(),
        });
        return;
    }

    // ── Proxy /api/* → http://localhost:3000/api/* ────────────────────────────
    if (pathname.startsWith('/api/')) {
        // Reconstrói a URL com query string
        const qs     = parsedUrl.search || '';
        const target = pathname + qs;
        proxyHttp(req, res, target);
        return;
    }

    // ── Proxy /ws/* é tratado no evento 'upgrade' (abaixo) ───────────────────
    // Requisições HTTP para /ws/* não são esperadas, mas retornamos 400.
    if (pathname.startsWith('/ws/')) {
        sendJson(res, 400, {
            error: 'Use WebSocket para conectar em /ws/*',
        });
        return;
    }

    // ── SPA: qualquer outra rota serve o dashboard.html ───────────────────────
    serveDashboard(req, res);
});

// ─── Proxy WebSocket (/ws/* → ws://localhost:3000/ws/*) ──────────────────────

server.on('upgrade', (req, clientSocket, head) => {
    const parsedUrl = url.parse(req.url || '/', true);
    const pathname  = parsedUrl.pathname || '/';

    if (!pathname.startsWith('/ws/')) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    // Reconstrói a URL com query string para encaminhar token JWT
    const qs         = parsedUrl.search || '';
    const targetPath = pathname + qs;

    const upstreamSocket = net.connect(API_PORT, API_HOST, () => {
        // Envia o handshake HTTP de upgrade para o servidor upstream
        const upgradeHeaders = [
            `GET ${targetPath} HTTP/1.1`,
            `Host: ${API_HOST}:${API_PORT}`,
            `Upgrade: websocket`,
            `Connection: Upgrade`,
        ];

        // Repassa headers relevantes do cliente
        const forwardHeaders = [
            'sec-websocket-key',
            'sec-websocket-version',
            'sec-websocket-extensions',
            'sec-websocket-protocol',
            'authorization',
            'cookie',
        ];

        for (const h of forwardHeaders) {
            if (req.headers[h]) {
                upgradeHeaders.push(`${h}: ${req.headers[h]}`);
            }
        }

        upgradeHeaders.push('\r\n');
        upstreamSocket.write(upgradeHeaders.join('\r\n'));

        if (head && head.length > 0) {
            upstreamSocket.write(head);
        }

        // Pipe bidirecional entre cliente e upstream
        upstreamSocket.pipe(clientSocket, { end: true });
        clientSocket.pipe(upstreamSocket, { end: true });
    });

    upstreamSocket.on('error', (err) => {
        console.error('[dashboard-server] Erro no proxy WebSocket:', err.message);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
        console.error('[dashboard-server] Erro no socket do cliente WS:', err.message);
        upstreamSocket.destroy();
    });

    clientSocket.on('close', () => {
        upstreamSocket.destroy();
    });

    upstreamSocket.on('close', () => {
        clientSocket.destroy();
    });
});

// ─── Inicialização ────────────────────────────────────────────────────────────

function start() {
    server.listen(DASHBOARD_PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║         SOFIA IA — Dashboard Server                 ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  Dashboard : http://localhost:${DASHBOARD_PORT}                  ║`);
        console.log(`║  Upstream  : http://${API_HOST}:${API_PORT}                    ║`);
        console.log('║  Proxy     : /api/* → upstream /api/*               ║');
        console.log('║  Proxy WS  : /ws/*  → upstream /ws/*                ║');
        console.log('║  Health    : GET /health                            ║');
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[dashboard-server] ❌ Porta ${DASHBOARD_PORT} já está em uso.`);
            console.error(`[dashboard-server]    Defina DASHBOARD_PORT para usar outra porta.`);
        } else {
            console.error('[dashboard-server] ❌ Erro no servidor:', err.message);
        }
        process.exit(1);
    });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
    console.log('\n[dashboard-server] 🛑 Encerrando...');
    server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
    console.log('\n[dashboard-server] 🛑 Encerrando (SIGTERM)...');
    server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
    console.error('[dashboard-server] ⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[dashboard-server] ⚠️ Uncaught Exception:', err.message);
    process.exit(1);
});

// ─── Start ────────────────────────────────────────────────────────────────────

start();
