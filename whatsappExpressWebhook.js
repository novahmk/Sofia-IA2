/**
 * SOFIA IA — Servidor Express Webhook (WASenderAPI)
 * ═══════════════════════════════════════════════════════════════
 *
 * Servidor Express que opera como:
 *   1. Webhook receiver para WhatsApp via WASenderAPI
 *   2. Health check endpoint
 *   3. Dashboard HTML estático
 *   4. Motor de IA conversacional (GPT-4o-mini via OpenAI)
 *
 * ROTAS:
 *   GET  /health    → { status: "ok", uptime: <seconds> }
 *   GET  /dashboard → Serve dashboard.html
 *   POST /webhook   → Recebe mensagens WhatsApp (WASenderAPI)
 *
 * VALIDAÇÃO DO WEBHOOK:
 *   Aceita assinatura via header x-webhook-signature ou x-webhook-secret
 *   Comparado com WASENDERAPI_WEBHOOK_SECRET (ou WEBHOOK_SECRET)
 *   Se a variável não estiver definida, aceita qualquer requisição
 *
 * VARIÁVEIS DE AMBIENTE:
 *   OPENAI_API_KEY              → Chave API OpenAI (obrigatória)
 *   WASENDERAPI_BASE_URL        → URL base WASenderAPI
 *   WASENDERAPI_TOKEN           → Token de autenticação WASenderAPI
 *   PHONE_NUMBER_ID             → ID do número de telefone (opcional)
 *   WEBHOOK_VERIFY_TOKEN        → Token de verificação do webhook
 *   WASENDERAPI_WEBHOOK_SECRET  → Secret para validar assinatura do webhook
 *   WEBHOOK_SECRET              → Alias para WASENDERAPI_WEBHOOK_SECRET
 *   DATABASE_URL                → PostgreSQL connection string (opcional)
 *   PORT                        → Porta do servidor (padrão: 3000)
 *
 * ═══════════════════════════════════════════════════════════════
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const fs = require('fs');

// ── Módulos internos ──────────────────────────────────────────
const { getSofiaResponse } = require('./ai');
const conversationManager = require('./conversationManager');
const inputSanitizer = require('./inputSanitizer');
const clientMemory = require('./clientMemory');
const MessagingClient = require('./messagingClient');
const kpiTracker = require('./kpiTracker');
const intentFlow = require('./intentFlow');
const topicBlacklist = require('./topicBlacklist');
const auditLogger = require('./auditLogger');
const selfHealing = require('./selfHealing');
const swop = require('./swop');

// ── Inicialização ─────────────────────────────────────────────
const app = express();
const messaging = new MessagingClient();

const PORT = parseInt(process.env.PORT || '3000', 10);

// Secret para validar assinatura do webhook (aceita ambos os nomes)
const WEBHOOK_SECRET =
    process.env.WASENDERAPI_WEBHOOK_SECRET ||
    process.env.WEBHOOK_SECRET ||
    '';

// Números de admin autorizados a usar comandos de controle
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

// ── Fila de mensagens por usuário (garante ordem de processamento) ──
const messageQueues = {};

// ── Rate limiting por usuário (anti-spam) ────────────────────
const rateLimits = {};
const RATE_LIMIT_WINDOW_MS = 60000;   // 1 minuto
const RATE_LIMIT_MAX_MESSAGES = 10;   // máximo de mensagens por janela

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Verifica se o usuário excedeu o rate limit.
 */
function isRateLimited(userPhone) {
    const now = Date.now();
    if (!rateLimits[userPhone]) {
        rateLimits[userPhone] = { timestamps: [], blocked: false };
    }
    const userRate = rateLimits[userPhone];
    userRate.timestamps = userRate.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    userRate.timestamps.push(now);

    if (userRate.timestamps.length > RATE_LIMIT_MAX_MESSAGES) {
        if (!userRate.blocked) {
            userRate.blocked = true;
            console.warn(`🚫 Rate limit atingido para ${userPhone} (${userRate.timestamps.length} msgs em 1min)`);
        }
        return true;
    }
    userRate.blocked = false;
    return false;
}

/**
 * Calcula delay inteligente baseado na complexidade da mensagem e tamanho da resposta.
 */
function calculateSmartDelay(userText, sofiaReply) {
    const userWords = userText.trim().split(/\s+/).length;
    const replyWords = sofiaReply.trim().split(/\s+/).length;
    const hasQuestion = userText.includes('?');
    const isGreeting = /^(oi|olá|ola|hey|eai|e aí|bom dia|boa tarde|boa noite|opa|fala)\b/i.test(userText.trim());

    if (isGreeting && userWords <= 4) return 3000 + Math.random() * 3000;
    if (userWords <= 3 && !hasQuestion) return 2000 + Math.random() * 3000;
    if (userWords <= 8) return 5000 + Math.random() * 5000;
    if (userWords <= 20) return 8000 + Math.random() * 7000;

    let delay = 12000 + Math.random() * 10000;
    if (replyWords > 50) delay += 3000 + Math.random() * 4000;
    return Math.min(delay, 25000);
}

/**
 * Enfileira e processa mensagens sequencialmente por usuário.
 */
function enqueueMessage(userPhone, handler) {
    if (!messageQueues[userPhone]) {
        messageQueues[userPhone] = Promise.resolve();
    }
    messageQueues[userPhone] = messageQueues[userPhone]
        .then(() => handler())
        .catch(err => console.error(`❌ Erro na fila de ${userPhone}:`, err.message));
}

/**
 * Extrai número de telefone limpo (apenas dígitos) de um JID ou string.
 */
function extractPhone(raw) {
    return String(raw || '')
        .replace('@s.whatsapp.net', '')
        .replace(/@.*$/, '')
        .replace(/[^0-9]/g, '');
}

// ─────────────────────────────────────────────────────────────
// Processamento de mensagem recebida
// ─────────────────────────────────────────────────────────────

/**
 * Processa uma mensagem recebida via webhook da WASenderAPI.
 */
async function processIncomingMessage(webhookData) {
    if (webhookData.fromMe) return;
    if (webhookData.isGroup) return;

    const userPhone = webhookData.phone;
    if (!userPhone) return;

    if (isRateLimited(userPhone)) {
        console.log(`🚫 Mensagem de ${userPhone} bloqueada por rate limit`);
        auditLogger.rateLimited(userPhone, rateLimits[userPhone]?.timestamps?.length || 0);
        return;
    }

    enqueueMessage(userPhone, async () => {
        const messageStartTime = Date.now();
        conversationManager.initializeConversation(userPhone);
        await messaging.sendTyping(userPhone);

        try {
            let userText = webhookData.text?.message || webhookData.text?.body || '';

            // ── Sanitizar input ──────────────────────────────
            const sanitized = inputSanitizer.sanitize(userText, userPhone);
            userText = sanitized.sanitized;
            if (sanitized.flags.length > 0) {
                console.log(`🛡️ Input sanitizado [${userPhone}]: flags=[${sanitized.flags.join(', ')}]`);
                auditLogger.inputSanitized(userPhone, sanitized.flags);
            }

            // ── Comandos de controle ─────────────────────────
            const commandCheck = conversationManager.isControlCommand(userText);
            if (commandCheck.isCommand) {
                if (ADMIN_PHONES.length > 0 && !ADMIN_PHONES.includes(userPhone)) {
                    console.log(`⚠️ Comando bloqueado de número não-admin: ${userPhone}`);
                } else {
                    console.log(`\n⚡ COMANDO DETECTADO: ${commandCheck.command}`);
                    const commandResponse = conversationManager.processCommand(userPhone, commandCheck.command);
                    auditLogger.command(userPhone, commandCheck.command);
                    await messaging.sendMessage(userPhone, commandResponse);
                    console.log(`[Sistema -> ${userPhone}]: Comando processado`);
                    conversationManager.recordMessage(userPhone, 'system', `comando: ${commandCheck.command}`);
                    await messaging.stopTyping(userPhone);
                    return;
                }
            }

            // ── Modo manual ──────────────────────────────────
            if (!conversationManager.shouldSofiaRespond(userPhone)) {
                console.log(`\n[${userPhone}] 📝 Mensagem registrada (Modo Manual Ativo)`);
                conversationManager.recordMessage(userPhone, 'client', userText);
                const notifications = [
                    '✅ Mensagem recebida e registrada.',
                    '✅ Anotado.',
                    '✅ Certo, anotei.',
                    '✅ OK, registrado.',
                ];
                await messaging.sendMessage(
                    userPhone,
                    notifications[Math.floor(Math.random() * notifications.length)]
                );
                await messaging.stopTyping(userPhone);
                return;
            }

            // ── Validar texto ────────────────────────────────
            if (!userText) {
                console.log(`⚠️ Mensagem sem texto de ${userPhone}, ignorando`);
                await messaging.stopTyping(userPhone);
                return;
            }
            console.log(`\n[${userPhone}] Mensagem recebida: ${userText}`);

            // ── Blacklist de tópicos ─────────────────────────
            const blacklistCheck = topicBlacklist.check(userText, userPhone);
            if (blacklistCheck.blocked) {
                auditLogger.topicBlocked(userPhone, blacklistCheck.topic);
                await messaging.sendMessage(userPhone, blacklistCheck.deflectionResponse);
                auditLogger.msgSent(userPhone, blacklistCheck.deflectionResponse);
                await messaging.stopTyping(userPhone);
                return;
            }

            // ── Registros pré-IA ─────────────────────────────
            auditLogger.msgReceived(userPhone, userText, 'text');
            const currentIntent = intentFlow.recordIntent(userPhone, userText);

            // ── Chamar IA ────────────────────────────────────
            const responseStartTime = Date.now();
            const sofiaReply = await getSofiaResponse(userPhone, userText, null);
            const responseLatency = Date.now() - responseStartTime;

            conversationManager.recordMessage(userPhone, 'client', userText);

            // ── KPI + Audit ──────────────────────────────────
            const clientMem = clientMemory.getClientMemory(userPhone);
            kpiTracker.recordMessage(userPhone, {
                responseTimeMs: responseLatency,
                mediaType: 'text',
                intent: currentIntent,
                funnelStage: clientMem.funnel_stage,
                sentiment: clientMem.sentiment,
            });
            auditLogger.aiResponse(userPhone, responseLatency, false);

            // ── Delay inteligente ────────────────────────────
            const typingDelay = calculateSmartDelay(userText, sofiaReply);
            console.log(`⏳ Aguardando ${(typingDelay / 1000).toFixed(1)}s antes de enviar resposta...`);
            await new Promise(resolve => setTimeout(resolve, typingDelay));

            // ── Enviar resposta ──────────────────────────────
            await messaging.sendMessage(userPhone, sofiaReply);
            const totalLatency = Date.now() - messageStartTime;

            conversationManager.recordMessage(userPhone, 'sofia', sofiaReply);
            auditLogger.msgSent(userPhone, sofiaReply);

            console.log(`[Sofia -> ${userPhone}]: ${sofiaReply}`);
            console.log(`⚡ Latência total: ${totalLatency}ms (IA: ${responseLatency}ms)`);

            swop.recordLatency(userPhone, userText.length, responseLatency, 'success', 'text');

        } catch (error) {
            console.error('Erro interno ao processar a mensagem:', error);
            swop.recordError(userPhone, error.message, error.name || 'PROCESSING_ERROR');
            auditLogger.error(userPhone, error.message, error.name || 'PROCESSING_ERROR');

            const healing = await selfHealing.analyze(error, null, { userId: userPhone, operation: 'process_message' });
            console.log(`🔧 Self-Healing análise: ${healing.analysis}`);
            auditLogger.selfHealing(userPhone, error.name, healing.recovered, healing.analysis);

            try {
                await messaging.sendMessage(
                    userPhone,
                    'Nossa, desculpa, mas minha conexão deu uma leve travada aqui. O que você me falou por último?'
                );
            } catch (sendError) {
                swop.recordError(userPhone, sendError.message, 'MESSAGE_SEND_ERROR');
            }
        } finally {
            await messaging.stopTyping(userPhone);
        }
    });
}

// ─────────────────────────────────────────────────────────────
// Middleware global
// ─────────────────────────────────────────────────────────────

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-webhook-signature, x-webhook-secret');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Parsear JSON para todas as rotas (exceto /webhook que usa raw body)
app.use((req, res, next) => {
    if (req.path === '/webhook') return next();
    express.json()(req, res, next);
});

// ─────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ─────────────────────────────────────────────────────────────
// GET /dashboard
// ─────────────────────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
    const dashPath = path.join(__dirname, 'dashboard.html');
    if (!fs.existsSync(dashPath)) {
        return res.status(404).send('Dashboard não encontrado.');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(dashPath);
});

// ─────────────────────────────────────────────────────────────
// POST /webhook  — recebe mensagens WhatsApp via WASenderAPI
// ─────────────────────────────────────────────────────────────

// Captura raw body para validação de assinatura
app.use('/webhook', express.raw({ type: '*/*', limit: '1mb' }));

app.post('/webhook', (req, res) => {
    // ── Validar assinatura ───────────────────────────────────
    const signature =
        req.headers['x-webhook-signature'] ||
        req.headers['x-webhook-secret'] ||
        req.headers['x-api-key'] ||
        '';

    const headerSource = req.headers['x-webhook-signature']
        ? 'x-webhook-signature'
        : req.headers['x-webhook-secret']
            ? 'x-webhook-secret'
            : req.headers['x-api-key']
                ? 'x-api-key'
                : 'none';

    if (WEBHOOK_SECRET && (!signature || signature !== WEBHOOK_SECRET)) {
        console.warn(`🚨 Webhook rejeitado: assinatura inválida (header=${headerSource}, ip=${req.ip})`);
        return res.status(403).json({ error: 'Forbidden' });
    }

    // Responder imediatamente para não bloquear o provider
    res.status(200).json({ status: 'received' });

    // ── Parsear body ─────────────────────────────────────────
    let data;
    try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body || '{}');
        data = JSON.parse(rawBody);
    } catch (parseError) {
        console.error('❌ Erro ao parsear webhook body:', parseError.message);
        return;
    }

    console.log(`\n📩 Webhook recebido — evento: ${data.event || 'desconhecido'}`);

    // ── Normalizar payload WASenderAPI ───────────────────────
    // Formato esperado: { event: "messages.received", data: { messages: [...] } }
    const isWasender = data.event === 'messages.received' && data.data && data.data.messages;

    let userPhone = '';
    let fromMe = false;
    let isGroup = false;
    let messageText = '';

    if (isWasender) {
        const messageObject = Array.isArray(data.data.messages)
            ? data.data.messages[0]
            : data.data.messages;

        const key = messageObject.key || {};
        const remote = key.remoteJid || key.senderPn || key.cleanedSenderPn || key.senderLid || '';

        userPhone = extractPhone(remote);
        if (!userPhone && key.cleanedSenderPn) userPhone = extractPhone(key.cleanedSenderPn);
        if (!userPhone && key.senderLid) userPhone = extractPhone(key.senderLid);

        fromMe = Boolean(key.fromMe);
        isGroup = String(key.remoteJid || '').endsWith('@g.us');
        messageText =
            messageObject.messageBody ||
            messageObject.message?.conversation ||
            messageObject.message?.extendedTextMessage?.text ||
            '';
    } else {
        // Formato genérico / fallback
        userPhone = extractPhone(data.phone || data.from || data.sender || '');
        fromMe = Boolean(data.fromMe);
        isGroup = Boolean(data.isGroup);
        messageText =
            data.message?.text ||
            data.text?.message ||
            data.body ||
            (typeof data.message === 'string' ? data.message : '');
    }

    if (!userPhone || fromMe || isGroup || !messageText) {
        console.log(`⏭️ Webhook ignorado — phone=${userPhone || 'vazio'}, fromMe=${fromMe}, isGroup=${isGroup}, text=${messageText ? 'ok' : 'vazio'}`);
        return;
    }

    console.log(`📩 Mensagem de ${userPhone}: "${messageText.substring(0, 80)}"`);

    const webhookData = {
        phone: userPhone,
        fromMe,
        isGroup,
        text: { message: messageText, body: messageText },
    };

    processIncomingMessage(webhookData);
});

// ─────────────────────────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────────────────────────

app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// ─────────────────────────────────────────────────────────────
// Iniciar servidor
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║          SOFIA IA — Express Webhook Server           ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`🚀 Servidor iniciado na porta ${PORT}`);
    console.log(`📡 Provider: ${messaging.provider?.toUpperCase() || 'não configurado'}`);
    console.log(`🔐 Webhook secret: ${WEBHOOK_SECRET ? '✅ configurado' : '⚠️  não configurado (aceita qualquer requisição)'}`);
    console.log(`🤖 OpenAI: ${process.env.OPENAI_API_KEY ? '✅ configurado' : '❌ OPENAI_API_KEY ausente'}`);
    console.log('');
    console.log('Endpoints disponíveis:');
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  GET  http://localhost:${PORT}/dashboard`);
    console.log(`  POST http://localhost:${PORT}/webhook`);
    console.log('');
});

module.exports = app;
