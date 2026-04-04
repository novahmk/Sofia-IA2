/**
 * SOFIA IA — Servidor de Dashboard
 * ═══════════════════════════════════════════════════════════════
 *
 * Servidor HTTP dedicado exclusivamente ao dashboard administrativo.
 * Separa o tráfego de UI do servidor principal (index.js) que processa
 * webhooks e mensagens WhatsApp, eliminando contenção de recursos.
 *
 * RESPONSABILIDADES:
 *   1. Servir dashboard.html como SPA com cache headers adequados
 *   2. Proxy reverso transparente: /api/* → http://localhost:PORT/api/*
 *   3. Proxy reverso WebSocket: /ws/*  → ws://localhost:PORT/ws/*
 *   4. Compressão gzip para respostas de texto
 *   5. CORS headers para aceitar requisições do frontend
 *   6. Health check próprio em /health
 *   7. Logging de todas as requisições
 *
 * PORTAS:
 *   Dashboard: process.env.DASHBOARD_PORT || (PORT + 1) || 3001
 *   API (proxy target): process.env.PORT || 3000
 *
 * DEPLOY:
 *   Iniciado junto com index.js via script "start:all" no package.json
 *   Railway usa o Procfile ou startCommand do railway.toml
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

// ── Configuração de portas ──────────────────────────────────────
const API_PORT = parseInt(process.env.PORT || '3000', 10);
const DASHBOARD_PORT = parseInt(
    process.env.DASHBOARD_PORT || String(API_PORT + 1),
    10
);
const API_HOST = process.env.API_HOST || 'localhost';
const API_BASE = `http://${API_HOST}:${API_PORT}`;

// ── Caminho do dashboard HTML ───────────────────────────────────
const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

// ── Tipos MIME para assets estáticos ───────────────────────────
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff2':'font/woff2',
    '.woff': 'font/woff',
};

// ── Cabeçalhos CORS ─────────────────────────────────────────────
const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// ── Utilitários ─────────────────────────────────────────────────

/**
 * Formata timestamp para logging
 */
function timestamp() {
    return new Date().toISOString();
}

/**
 * Loga uma requisição no formato: [ISO] METHOD /path → STATUS (Xms)
 */
function logRequest(method, url, status, durationMs) {
    const statusIcon = status < 300 ? '✅' : status < 400 ? '↩️' : status < 500 ? '⚠️' : '❌';
    console.log(`[${timestamp()}] ${statusIcon} ${method} ${url} → ${status} (${durationMs}ms)`);
}

/**
 * Verifica se o cliente aceita compressão gzip
 */
function acceptsGzip(req) {
    return (req.headers['accept-encoding'] || '').includes('gzip');
}

/**
 * Envia resposta com compressão gzip opcional
 */
function sendCompressed(res, statusCode, headers, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');

    // Não comprimir respostas pequenas (< 1 KB) ou tipos binários
    const contentType = headers['Content-Type'] || '';
    const isText = /text|json|javascript|xml|svg/.test(contentType);

    if (isText && buf.length > 1024 && res._acceptsGzip) {
        zlib.gzip(buf, (err, compressed) => {
            if (err) {
                res.writeHead(statusCode, { ...headers, ...CORS_HEADERS });
                res.end(buf);
                return;
            }
            res.writeHead(statusCode, {
                ...headers,
                ...CORS_HEADERS,
                'Content-Encoding': 'gzip',
                'Content-Length': compressed.length,
            });
            res.end(compressed);
        });
    } else {
        res.writeHead(statusCode, {
            ...headers,
            ...CORS_HEADERS,
            'Content-Length': buf.length,
        });
        res.end(buf);
    }
}

// ── Proxy HTTP reverso ──────────────────────────────────────────

/**
 * Faz proxy de uma requisição HTTP para o servidor de API (index.js).
 * Preserva método, headers, body e status code originais.
 */
function proxyHttpRequest(req, res, startTime) {
    const targetUrl = new URL(req.url, API_BASE);

    const options = {
        hostname: API_HOST,
        port:     API_PORT,
        path:     targetUrl.pathname + targetUrl.search,
        method:   req.method,
        headers:  {
            ...req.headers,
            host: `${API_HOST}:${API_PORT}`,
            'x-forwarded-for':   req.socket.remoteAddress || '',
            'x-forwarded-host':  req.headers.host || '',
            'x-forwarded-proto': 'http',
        },
    };

    const proxyReq = http.request(options, (proxyRes) => {
        const duration = Date.now() - startTime;
        logRequest(req.method, req.url, proxyRes.statusCode, duration);

        // Repassar headers da resposta da API, adicionando CORS
        const responseHeaders = {
            ...proxyRes.headers,
            ...CORS_HEADERS,
        };

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        const duration = Date.now() - startTime;
        console.error(`[${timestamp()}] ❌ Proxy error ${req.method} ${req.url}: ${err.message}`);
        logRequest(req.method, req.url, 502, duration);

        if (!res.headersSent) {
            res.writeHead(502, {
                'Content-Type': 'application/json',
                ...CORS_HEADERS,
            });
            res.end(JSON.stringify({
                error: 'Bad Gateway',
                message: 'Servidor de API indisponível. Verifique se index.js está rodando.',
                target: API_BASE,
            }));
        }
    });

    // Encaminhar body da requisição original para o proxy
    req.pipe(proxyReq, { end: true });
}

// ── Proxy WebSocket reverso ─────────────────────────────────────

/**
 * Faz upgrade de conexão WebSocket para o servidor de API.
 * Necessário para /ws/dashboard?token=JWT funcionar através do dashboard-server.
 */
function proxyWebSocket(req, socket, head) {
    console.log(`[${timestamp()}] 🔌 WS upgrade: ${req.url}`);

    const targetOptions = {
        hostname: API_HOST,
        port:     API_PORT,
        path:     req.url,
        headers:  {
            ...req.headers,
            host: `${API_HOST}:${API_PORT}`,
        },
    };

    const proxyReq = http.request(targetOptions);

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        // Montar resposta de handshake WebSocket
        const responseLines = [
            `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
        ];
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            responseLines.push(`${key}: ${value}`);
        }
        responseLines.push('', '');

        socket.write(responseLines.join('\r\n'));

        if (proxyHead && proxyHead.length > 0) {
            proxySocket.unshift(proxyHead);
        }

        // Pipe bidirecional entre cliente e API
        proxySocket.pipe(socket, { end: true });
        socket.pipe(proxySocket, { end: true });

        proxySocket.on('error', (err) => {
            console.error(`[${timestamp()}] ❌ WS proxy socket error: ${err.message}`);
            socket.destroy();
        });

        socket.on('error', (err) => {
            console.error(`[${timestamp()}] ❌ WS client socket error: ${err.message}`);
            proxySocket.destroy();
        });
    });

    proxyReq.on('error', (err) => {
        console.error(`[${timestamp()}] ❌ WS proxy request error: ${err.message}`);
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
    });

    proxyReq.end();
}

// ── Servidor HTTP ───────────────────────────────────────────────

const server = http.createServer((req, res) => {
    const startTime = Date.now();

    // Marcar se o cliente aceita gzip (usado em sendCompressed)
    res._acceptsGzip = acceptsGzip(req);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        logRequest('OPTIONS', req.url, 204, Date.now() - startTime);
        return;
    }

    const urlPath = req.url.split('?')[0];

    // ── Health check próprio do dashboard-server ──────────────
    if (req.method === 'GET' && urlPath === '/health') {
        const body = JSON.stringify({
            status:    'ok',
            service:   'dashboard-server',
            port:      DASHBOARD_PORT,
            apiTarget: API_BASE,
            uptime:    process.uptime(),
            timestamp: new Date().toISOString(),
        });
        sendCompressed(res, 200, { 'Content-Type': 'application/json' }, body);
        logRequest('GET', '/health', 200, Date.now() - startTime);
        return;
    }

    // ── Proxy: /api/* → API server ────────────────────────────
    if (urlPath.startsWith('/api/')) {
        proxyHttpRequest(req, res, startTime);
        return;
    }

    // ── Proxy: /webhook e /metrics → API server ───────────────
    // (Permite que o dashboard-server seja usado como único ponto de entrada)
    if (urlPath === '/webhook' || urlPath === '/metrics') {
        proxyHttpRequest(req, res, startTime);
        return;
    }

    // ── Servir dashboard.html para qualquer rota GET ──────────
    // SPA: todas as rotas de navegação retornam o mesmo HTML
    if (req.method === 'GET') {
        try {
            const html = fs.readFileSync(DASHBOARD_HTML_PATH);
            sendCompressed(res, 200, {
                'Content-Type':  'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma':        'no-cache',
                'Expires':       '0',
            }, html);
            logRequest('GET', req.url, 200, Date.now() - startTime);
        } catch (err) {
            const body = JSON.stringify({ error: 'Dashboard não encontrado', path: DASHBOARD_HTML_PATH });
            sendCompressed(res, 404, { 'Content-Type': 'application/json' }, body);
            logRequest('GET', req.url, 404, Date.now() - startTime);
        }
        return;
    }

    // ── 404 para qualquer outra rota ──────────────────────────
    const body = JSON.stringify({ error: 'Not Found' });
    sendCompressed(res, 404, { 'Content-Type': 'application/json' }, body);
    logRequest(req.method, req.url, 404, Date.now() - startTime);
});

// ── Proxy WebSocket (upgrade event) ────────────────────────────
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/ws/')) {
        proxyWebSocket(req, socket, head);
    } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    }
});

// ── Tratamento de erros do servidor ────────────────────────────
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Porta ${DASHBOARD_PORT} já está em uso.`);
        console.error(`   Defina DASHBOARD_PORT para usar outra porta.`);
    } else {
        console.error(`❌ Erro no dashboard-server: ${err.message}`);
    }
    process.exit(1);
});

// ── Inicialização ───────────────────────────────────────────────
server.listen(DASHBOARD_PORT, () => {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('📊 SOFIA IA — Dashboard Server');
    console.log('══════════════════════════════════════════════════════');
    console.log(`   Porta:       ${DASHBOARD_PORT}`);
    console.log(`   API target:  ${API_BASE}`);
    console.log(`   Dashboard:   http://localhost:${DASHBOARD_PORT}/`);
    console.log(`   Health:      http://localhost:${DASHBOARD_PORT}/health`);
    console.log(`   Proxy /api:  http://localhost:${DASHBOARD_PORT}/api/*`);
    console.log(`   Proxy /ws:   ws://localhost:${DASHBOARD_PORT}/ws/*`);
    console.log('══════════════════════════════════════════════════════\n');
});

// ── Graceful shutdown ───────────────────────────────────────────
function shutdown(signal) {
    console.log(`\n🛑 Dashboard Server encerrando (${signal})...`);
    server.close(() => {
        console.log('✅ Dashboard Server encerrado.');
        process.exit(0);
    });
    // Forçar encerramento após 5s se não fechar limpo
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    console.error(`[${timestamp()}] ❌ Uncaught Exception: ${err.message}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error(`[${timestamp()}] ⚠️ Unhandled Rejection: ${reason}`);
});
