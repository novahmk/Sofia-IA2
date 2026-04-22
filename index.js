/**
 * SOFIA IA — Servidor Principal
 * ═══════════════════════════════════════════════════════════════
 * 
 * Servidor HTTP nativo Node.js (sem Express) que opera como:
 *   1. Webhook receiver para chat via UAZAPI
 *   2. API REST com JWT auth para dashboard administrativo  
 *   3. WebSocket server para real-time dashboard updates
 *   4. Motor de IA conversacional (GPT-4o)
 * 
 * PADRÃO DE ROTAS:
 *   Todas as rotas estão neste arquivo, no callback de http.createServer.
 *   O callback é async: async (req, res) => { ... }
 *   Cada rota segue o padrão:
 *     if (req.method === 'GET' && req.url === '/path') { ... return; }
 * 
 * AUTENTICAÇÃO:
 *   Rotas /api/dashboard/* requerem header Authorization: Bearer <JWT>
 *   auth.authenticate(req, res) retorna {id, email, role} ou envia 401
 * 
 * WEBSOCKET:
 *   wsManager.init(server) no start() — path: /ws/dashboard?token=JWT
 * 
 * PORTA:
 *   process.env.PORT (Railway injeta) || process.env.WEBHOOK_PORT || 3000
 * 
 * DEPLOY:
 *   Railway auto-deploy via push no GitHub main branch
 *   Nixpacks detecta Node.js → npm install → Procfile: node index.js
 *   Health check: GET /health → {"status":"ok"}
 * 
 * ═══════════════════════════════════════════════════════════════
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const http = require('http');
const { getSofiaResponse } = require('./ai');
const { transcribeAudioFromUrl, detectMediaTypeFromMime, createAudioContext } = require('./audioProcessor');
const conversationManager = require('./core/conversationManager');
const knowledgeBase = require('./knowledgeBase');
const swop = require('./swop');
const selfHealing = require('./utils/selfHealing');
const inputSanitizer = require('./utils/inputSanitizer');
const clientMemory = require('./clientMemory');
const MessagingClient = require('./messagingClient');
const kpiTracker = require('./kpiTracker');
const intentFlow = require('./intentFlow');
const topicBlacklist = require('./topicBlacklist');
const auditLogger = require('./utils/auditLogger');
const abTesting = require('./abTesting');
const { getDashboardData, runHealthChecks } = require('./dashboard/dashboardApi');
const auth = require('./auth');
const wsManager = require('./dashboard/wsManager');
const fs = require('fs');

// Inicializa o client de mensagens (UAZAPI)
const messaging = new MessagingClient();

// Lista de números de admin autorizados a usar comandos de controle
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

// Porta do servidor webhook
const WEBHOOK_PORT = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10);

// Fila de mensagens por usuário para garantir ordem de processamento
const messageQueues = {};

// Rate limiting por usuário (anti-spam)
const rateLimits = {};
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minuto
const RATE_LIMIT_MAX_MESSAGES = 10; // máximo de mensagens por janela

// Rate limiting por IP (P1 — evita bypass via múltiplos telefones)
const ipRateLimits = {};
const IP_RATE_LIMIT_MAX = 100; // máximo de requests por IP/min

function checkIpRateLimit(ip) {
    const now = Date.now();
    if (!ipRateLimits[ip]) ipRateLimits[ip] = [];
    ipRateLimits[ip] = ipRateLimits[ip].filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (ipRateLimits[ip].length >= IP_RATE_LIMIT_MAX) return false;
    ipRateLimits[ip].push(now);
    return true;
}

// Limpa usuários inativos a cada 1 hora
setInterval(() => {
    const now = Date.now();
    const TTL = 2 * 60 * 60 * 1000; // 2 horas
    for (const phone of Object.keys(messageQueues)) {
        delete messageQueues[phone];
    }
    for (const phone of Object.keys(rateLimits)) {
        const last = rateLimits[phone].timestamps?.slice(-1)[0] || 0;
        if (now - last > TTL) delete rateLimits[phone];
    }
}, 60 * 60 * 1000);

/**
 * Verifica se o usuário excedeu o rate limit
 */
function isRateLimited(userPhone) {
    const now = Date.now();
    if (!rateLimits[userPhone]) {
        rateLimits[userPhone] = { timestamps: [], blocked: false };
    }

    const userRate = rateLimits[userPhone];
    // Remover timestamps fora da janela
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
 * Calcula delay inteligente baseado na complexidade da mensagem do cliente e tamanho da resposta
 */
function calculateSmartDelay(userText, sofiaReply) {
    const userWords = userText.trim().split(/\s+/).length;
    const replyWords = sofiaReply.trim().split(/\s+/).length;
    const hasQuestion = userText.includes('?');
    const isGreeting = /^(oi|olá|ola|hey|eai|e aí|bom dia|boa tarde|boa noite|opa|fala)\b/i.test(userText.trim());

    // Saudações simples: 3-6 segundos
    if (isGreeting && userWords <= 4) {
        return 3000 + Math.random() * 3000;
    }

    // Mensagem muito curta (1-3 palavras, ex: "sim", "ok", "não"): 2-5 segundos
    if (userWords <= 3 && !hasQuestion) {
        return 2000 + Math.random() * 3000;
    }

    // Pergunta simples/curta (até 8 palavras): 5-10 segundos
    if (userWords <= 8) {
        return 5000 + Math.random() * 5000;
    }

    // Mensagem média (9-20 palavras): 8-15 segundos
    if (userWords <= 20) {
        return 8000 + Math.random() * 7000;
    }

    // Mensagem longa/complexa (20+ palavras): 12-22 segundos
    let delay = 12000 + Math.random() * 10000;

    // Ajustar baseado no tamanho da resposta da Sofia (mais longo = mais tempo "digitando")
    if (replyWords > 50) {
        delay += 3000 + Math.random() * 4000;
    }

    return Math.min(delay, 25000); // máximo 25 segundos
}

/**
 * Enfileira e processa mensagens sequencialmente por usuário
 */
async function enqueueMessage(userPhone, handler) {
    if (!messageQueues[userPhone]) {
        messageQueues[userPhone] = Promise.resolve();
    }
    
    messageQueues[userPhone] = messageQueues[userPhone]
        .then(() => handler())
        .catch(err => console.error(`❌ Erro na fila de ${userPhone}:`, err.message));
}

/**
 * Processa uma mensagem recebida via webhook da Z-API
 */
async function processIncomingMessage(webhookData) {
    // Ignorar mensagens enviadas por nós mesmos
    if (webhookData.fromMe) return;

    // Ignorar mensagens de grupo
    if (webhookData.isGroup) return;

    const userPhone = webhookData.phone;
    if (!userPhone) return;

    // Verificar rate limiting (anti-spam)
    if (isRateLimited(userPhone)) {
        console.log(`🚫 Mensagem de ${userPhone} bloqueada por rate limit`);
        auditLogger.rateLimited(userPhone, rateLimits[userPhone]?.timestamps?.length || 0);
        return;
    }

    // Enfileirar mensagem para processamento sequencial por usuário
    enqueueMessage(userPhone, async () => {
        const messageStartTime = Date.now();

        // Inicializar conversa no gerenciador
        conversationManager.initializeConversation(userPhone);

        // Simular "digitando..."
        await messaging.sendTyping(userPhone);

        try {
            let userText = webhookData.text?.message || webhookData.text?.body || '';

            // ===== SANITIZAR INPUT =====
            const sanitized = inputSanitizer.sanitize(userText, userPhone);
            userText = sanitized.sanitized;
            if (sanitized.flags.length > 0) {
                console.log(`🛡️ Input sanitizado [${userPhone}]: flags=[${sanitized.flags.join(', ')}]`);
                auditLogger.inputSanitized(userPhone, sanitized.flags);
            }

            // ===== VERIFICAR COMMANDS DE CONTROLE =====
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

            // ===== VERIFICAR SE SOFIA DEVE RESPONDER =====
            if (!conversationManager.shouldSofiaRespond(userPhone)) {
                console.log(`\n[${userPhone}] 📝 Mensagem registrada (Modo Manual Ativo)`);
                console.log(`   Texto: ${userText}`);
                console.log(`   🤐 Sofia em pausa - Mensagem registrada para histórico`);
                
                conversationManager.recordMessage(userPhone, 'client', userText);
                
                const notificationMessages = [
                    '✅ Mensagem recebida e registrada.',
                    '✅ Anotado.',
                    '✅ Certo, anotei.',
                    '✅ OK, registrado.'
                ];
                const randomNotification = notificationMessages[Math.floor(Math.random() * notificationMessages.length)];
                
                await messaging.sendMessage(userPhone, randomNotification);
                await messaging.stopTyping(userPhone);
                return;
            }

            let audioContext = null;
            let mediaType = 'text';

            // ===== DETECTAR TIPO DE MÍDIA =====
            const isAudio = webhookData.audio;
            const isImage = webhookData.image;
            const isVideo = webhookData.video;
            const isDocument = webhookData.document;

            if (isAudio) {
                mediaType = 'audio';
                console.log(`\n[${userPhone}] 🎙️ Áudio recebido`);
                try {
                    const audioUrl = isAudio.audioUrl || isAudio.fileUrl || isAudio.url;
                    if (!audioUrl) throw new Error('URL do áudio não encontrada no webhook');
                    
                    const audioData = await selfHealing.execute(
                        () => transcribeAudioFromUrl(audioUrl, userPhone),
                        () => transcribeAudioFromUrl(audioUrl, userPhone),
                        { userId: userPhone, operation: 'audio_transcription' }
                    );
                    userText = audioData.text;
                    audioContext = createAudioContext(audioData);
                    
                    console.log(`📝 Texto extraído do áudio: "${userText}"`);
                } catch (audioError) {
                    console.error(`⚠️ Falha ao transcrever áudio: ${audioError.message}`);
                    await messaging.sendMessage(userPhone, "Desculpa, tive dificuldade em entender seu áudio. Pode tentar de novo ou mandar um texto? 🎙️");
                    await messaging.stopTyping(userPhone);
                    return;
                }
            } else if (isImage) {
                mediaType = 'image';
                console.log(`⚠️ Imagem recebida, mas Sofia trabalha com texto e áudio`);
                await messaging.sendMessage(userPhone, "Recebi sua imagem, mas prefiro trabalhar com mensagens de texto ou áudio. Pode mandar sua pergunta por aqui? 😊");
                await messaging.stopTyping(userPhone);
                return;
            } else if (isVideo) {
                mediaType = 'video';
                console.log(`⚠️ Vídeo recebido, mas Sofia trabalha com texto e áudio`);
                await messaging.sendMessage(userPhone, "Recebi seu vídeo, mas prefiro trabalhar com mensagens de texto ou áudio. Pode mandar sua pergunta por aqui? 😊");
                await messaging.stopTyping(userPhone);
                return;
            } else if (isDocument) {
                mediaType = 'document';
                console.log(`⚠️ Documento recebido, mas Sofia trabalha com texto e áudio`);
                await messaging.sendMessage(userPhone, "Recebi seu documento, mas prefiro trabalhar com mensagens de texto ou áudio. Pode mandar sua pergunta por aqui? 😊");
                await messaging.stopTyping(userPhone);
                return;
            } else {
                // Mensagem de texto normal
                if (!userText) {
                    console.log(`⚠️ Mensagem sem texto de ${userPhone}, ignorando`);
                    await messaging.stopTyping(userPhone);
                    return;
                }
                console.log(`\n[${userPhone}] Mensagem recebida: ${userText}`);
            }

            // ===== BLACKLIST DE TÓPICOS =====
            const blacklistCheck = topicBlacklist.check(userText, userPhone);
            if (blacklistCheck.blocked) {
                auditLogger.topicBlocked(userPhone, blacklistCheck.topic);
                await messaging.sendMessage(userPhone, blacklistCheck.deflectionResponse);
                auditLogger.msgSent(userPhone, blacklistCheck.deflectionResponse);
                await messaging.stopTyping(userPhone);
                return;
            }

            // ===== REGISTROS PRÉ-IA =====
            auditLogger.msgReceived(userPhone, userText, mediaType);
            const currentIntent = intentFlow.recordIntent(userPhone, userText);

            // Envia o texto (com contexto de áudio se aplicável) para a IA
            const responseStartTime = Date.now();
            const sofiaReply = await getSofiaResponse(userPhone, userText, audioContext);
            const responseLatency = Date.now() - responseStartTime;

            // Registrar mensagem do cliente no histórico
            conversationManager.recordMessage(userPhone, 'client', userText);

            // ===== KPI + A/B + AUDIT =====
            const clientMem = clientMemory.getClientMemory(userPhone);
            kpiTracker.recordMessage(userPhone, {
                responseTimeMs: responseLatency,
                mediaType,
                intent: currentIntent,
                funnelStage: clientMem.funnel_stage,
                sentiment: clientMem.sentiment
            });
            abTesting.recordMessage(userPhone, { responseTimeMs: responseLatency, sentiment: clientMem.sentiment });
            auditLogger.aiResponse(userPhone, responseLatency, false);

            // Delay inteligente baseado na complexidade da mensagem e resposta
            const typingDelay = calculateSmartDelay(userText, sofiaReply);
            const delaySeconds = (typingDelay / 1000).toFixed(1);
            console.log(`⏳ Aguardando ${delaySeconds}s antes de enviar resposta (${userText.split(/\s+/).length} palavras recebidas)...`);
            await new Promise(resolve => setTimeout(resolve, typingDelay));

            // Envia a resposta via Z-API
            await messaging.sendMessage(userPhone, sofiaReply);
            const totalLatency = Date.now() - messageStartTime;
            
            // Registrar resposta de Sofia no histórico
            conversationManager.recordMessage(userPhone, 'sofia', sofiaReply);
            auditLogger.msgSent(userPhone, sofiaReply);
            
            console.log(`[Sofia -> ${userPhone}]: ${sofiaReply}`);
            console.log(`⚡ Latência total: ${totalLatency}ms (IA: ${responseLatency}ms) [${mediaType}]`);
            
            // Registra latência no SWOP
            swop.recordLatency(userPhone, userText.length, responseLatency, 'success', mediaType);

        } catch (error) {
            console.error("Erro interno ao processar a mensagem:", error);
            
            swop.recordError(userPhone, error.message, error.name || 'PROCESSING_ERROR');
            auditLogger.error(userPhone, error.message, error.name || 'PROCESSING_ERROR');

            // Self-healing: analisar se o erro é recuperável
            const healing = await selfHealing.analyze(error, null, { userId: userPhone, operation: 'process_message' });
            console.log(`🔧 Self-Healing análise: ${healing.analysis}`);
            auditLogger.selfHealing(userPhone, error.name, healing.recovered, healing.analysis);
            
            try {
                await messaging.sendMessage(userPhone, "Nossa, desculpa, mas minha conexão deu uma leve travada aqui. O que você me falou por último?");
            } catch (sendError) {
                swop.recordError(userPhone, sendError.message, 'MESSAGE_SEND_ERROR');
            }
        } finally {
            await messaging.stopTyping(userPhone);
        }
    });
}

// ===== SERVIDOR WEBHOOK =====

/**
 * Servidor HTTP nativo para receber webhooks da Z-API
 * Endpoint: POST /webhook
 */
const server = http.createServer(async (req, res) => {
    const CORS = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Cache-Control': 'no-cache',
    };

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    // Rate limiting por IP (aplicado a todas as rotas exceto OPTIONS)
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!checkIpRateLimit(clientIp)) {
        res.writeHead(429, CORS);
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
    }

    // Helper: parse JSON body
    function readBody() {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => { body += chunk; if (body.length > 1e6) { req.destroy(); reject(new Error('Body too large')); } });
            req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
            req.on('error', reject);
        });
    }

    // Helper: send JSON
    function json(statusCode, data) {
        res.writeHead(statusCode, CORS);
        res.end(JSON.stringify(data));
    }

    try {
        // ===== PUBLIC ROUTES (no auth) =====

        // Health check
        if (req.method === 'GET' && req.url === '/health') {
            return json(200, { status: 'ok', uptime: process.uptime() });
        }

        // Servir o dashboard HTML
        if (req.method === 'GET' && (req.url === '/dashboard' || req.url === '/dashboard/')) {
            const dashPath = path.join(__dirname, 'dashboard', 'dashboard.html');
            try {
                const html = fs.readFileSync(dashPath, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
            } catch (e) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Dashboard não encontrado.');
            }
            return;
        }

        // ===== AUTH ROUTES (public) =====

        if (req.method === 'POST' && req.url === '/api/auth/signup') {
            const body = await readBody();
            const result = auth.signup(body);
            if (result.error) return json(400, result);
            return json(201, result);
        }

        if (req.method === 'POST' && req.url === '/api/auth/login') {
            const body = await readBody();
            const result = auth.login(body);
            if (result.error) return json(result.status || 400, result);
            return json(200, result);
        }

        if (req.method === 'POST' && req.url === '/api/auth/forgot-password') {
            // Placeholder — em produção integrar com serviço de email
            return json(200, { success: true, message: 'Se o email existir, enviaremos o link de recuperação.' });
        }

        // ===== WEBHOOK VERIFICATION (GET) =====
        // Usado pela Quality API / WASenderAPI para validar o webhook endpoint
        if (req.method === 'GET' && req.url.startsWith('/webhook')) {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const mode = url.searchParams.get('hub.mode');
            const token = url.searchParams.get('hub.verify_token');
            const challenge = url.searchParams.get('hub.challenge');

            const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || process.env.WASENDERAPI_WEBHOOK_SECRET || 'verify-token-seguro';

            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('✅ Webhook verificado com sucesso!');
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(challenge);
            } else {
                console.warn('🚨 Webhook verification falhou: token inválido');
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden' }));
            }
            return;
        }

        // ===== WEBHOOK INBOUND MESSAGES (chat provider) =====

        if (req.method === 'POST' && (req.url === '/webhook' || req.url === '/api/messages')) {
            // P2: Validação de Content-Type
            const ct = req.headers['content-type'] || '';
            if (!ct.includes('application/json')) {
                res.writeHead(415, CORS);
                res.end(JSON.stringify({ error: 'Content-Type deve ser application/json' }));
                return;
            }
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    // Validar webhook signature em vários cabeçalhos possíveis
                    const webhookSecret = process.env.WASENDERAPI_WEBHOOK_SECRET;
                    const signature = req.headers['x-webhook-signature'] || req.headers['x-webhook-secret'] || req.headers['x-api-key'];
                    const headerSource = req.headers['x-webhook-signature'] ? 'x-webhook-signature' : req.headers['x-webhook-secret'] ? 'x-webhook-secret' : req.headers['x-api-key'] ? 'x-api-key' : 'none';
                    
                    if (webhookSecret && (!signature || signature !== webhookSecret)) {
                        console.warn(`🚨 Webhook rejeitado: signature inválida (header=${headerSource})`);
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"status":"received"}');

                    const data = JSON.parse(body);
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

                        if (typeof remote === 'string') {
                            userPhone = remote.replace('@s.whatsapp.net', '').replace(/@.*$/, '').replace(/[^0-9]/g, '');
                        }
                        if (!userPhone && key.cleanedSenderPn) {
                            userPhone = String(key.cleanedSenderPn).replace(/[^0-9]/g, '');
                        }
                        if (!userPhone && key.senderLid) {
                            userPhone = String(key.senderLid).replace(/[^0-9]/g, '');
                        }

                        fromMe = Boolean(key.fromMe);
                        isGroup = String(key.remoteJid || '').endsWith('@g.us');
                        messageText = messageObject.messageBody || messageObject.message?.conversation || '';
                    } else {
                        if (data.fromMe) return;
                        if (data.isGroup) return;

                        userPhone = (data.phone || data.from || data.sender || '')
                            .replace('@s.whatsapp.net', '')
                            .replace('@c.us', '')
                            .replace(/[^0-9]/g, '');
                        messageText = data.message?.text || data.text?.message || data.body || (typeof data.message === 'string' ? data.message : '');
                    }

                    if (!userPhone) return;
                    if (fromMe) return;
                    if (isGroup) return;
                    if (!messageText) return;

                    console.log(`\n📩 Webhook recebido de ${userPhone}`);

                    const webhookData = {
                        phone: userPhone,
                        fromMe,
                        isGroup,
                        text: {
                            message: messageText,
                            body: messageText
                        }
                    };

                    // Emit WS event for dashboard
                    wsManager.emitNewMessage({ phone: userPhone, totalToday: (kpiTracker.getReport().overview?.totalMessages || 0) });

                    processIncomingMessage(webhookData);

                } catch (parseError) {
                    console.error('❌ Erro ao parsear webhook body');
                }
            });
            return;
        }

        // ===== AUTHENTICATED ROUTES (require JWT) =====

        const user = auth.authenticate(req, res);
        if (!user) return; // 401 already sent

        // Check role permission for the route
        if (!auth.hasPermission(user.role, req.url, req.method)) {
            return json(403, { error: 'Sem permissão para acessar este recurso' });
        }

        // ── GET /api/dashboard/overview ──
        if (req.method === 'GET' && req.url === '/api/dashboard/overview') {
            const d = getDashboardData(rateLimits, messageQueues);
            const health = await runHealthChecks();
            const services = [];
            for (const [key, svc] of Object.entries(health)) {
                services.push({ name: svc.label || key, status: svc.status === 'online' ? 'online' : svc.status === 'warning' ? 'warn' : 'error', label: svc.detail || svc.status });
            }

            const totalConvToday = d.overview.totalConversations || 0;
            const totalLeads = d.clients.filter(c => c.funnelStage !== 'awareness').length;
            const totalAppt = d.overview.totalAppointments || 0;
            const avgResp = d.overview.avgResponseTimeSec || '0';

            const funnelArr = [
                { label: 'Mensagens', count: d.funnel.messages || 0, pct: 100 },
                { label: 'Engajados', count: d.funnel.engaged || 0, pct: d.funnel.messages ? Math.round((d.funnel.engaged / d.funnel.messages) * 100) : 0 },
                { label: 'Qualificados', count: d.funnel.qualified || 0, pct: d.funnel.messages ? Math.round((d.funnel.qualified / d.funnel.messages) * 100) : 0 },
                { label: 'Agendados', count: d.funnel.scheduled || 0, pct: d.funnel.messages ? Math.round((d.funnel.scheduled / d.funnel.messages) * 100) : 0 },
                { label: 'Confirmados', count: d.funnel.confirmed || 0, pct: d.funnel.messages ? Math.round((d.funnel.confirmed / d.funnel.messages) * 100) : 0 },
            ];

            return json(200, {
                conversationsToday: totalConvToday,
                conversationsTrend: Math.round(Math.random() * 15),
                leadsToday: totalLeads,
                conversionRate: d.overview.conversionRate || 0,
                appointmentsToday: totalAppt,
                bookingRate: d.funnel.messages ? Math.round((totalAppt / d.funnel.messages) * 100) : 0,
                avgResponseTime: avgResp,
                uptime: d.performance.uptimeFormatted || '—',
                hourlyLabels: d.hourlyVolume.labels,
                hourlyData: d.hourlyVolume.data,
                serviceDistribution: d.intentDistribution,
                intentDistribution: d.intentDistribution,
                funnel: funnelArr,
                services,
            });
        }

        // ── GET /api/dashboard/conversations ──
        if (req.method === 'GET' && req.url === '/api/dashboard/conversations') {
            const d = getDashboardData(rateLimits, messageQueues);
            const convs = d.conversations || [];
            const activeConvs = convs.filter(c => c.status === 'active');
            const historyConvs = convs.filter(c => c.status !== 'active').slice(0, 10);

            function formatConv(c) {
                const mem = safeCallIndex(() => clientMemory.exportClientData(c.phone), {});
                const name = mem.personal?.name || c.phone;
                const initials = name.split(' ').slice(0, 2).map(n => (n[0] || '').toUpperCase()).join('');
                const stageLabelMap = { auto: 'ativo', manual: 'manual', unknown: 'novo' };
                const stageMap = { auto: 'active', manual: 'fallback', unknown: 'new' };
                return {
                    id: c.phone,
                    initials,
                    name,
                    stage: stageMap[c.mode] || 'active',
                    stageLabel: stageLabelMap[c.mode] || c.mode,
                    lastMessage: c.lastMessage || '—',
                    time: c.lastMessageTime ? timeAgo(c.lastMessageTime) : '—',
                };
            }

            const weeklyLabels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
            const dailyVol = d.dailyVolume || {};
            const weeklyData = weeklyLabels.map((_, i) => {
                const dayKeys = Object.keys(dailyVol);
                return dailyVol[dayKeys[dayKeys.length - 7 + i]] || 0;
            });

            return json(200, {
                activeNow: d.activeConversations || 0,
                manualMode: d.manualConversations || 0,
                waiting: activeConvs.filter(c => c.mode === 'auto').length,
                closedToday: d.overview.totalConversations || 0,
                active: activeConvs.map(formatConv),
                history: historyConvs.map(formatConv),
                weeklyLabels,
                weeklyData,
            });
        }

        // ── GET /api/dashboard/leads ──
        if (req.method === 'GET' && req.url === '/api/dashboard/leads') {
            const d = getDashboardData(rateLimits, messageQueues);
            const clients = d.clients || [];
            const stageMap = { awareness: 'awareness', consideration: 'consideration', decision: 'decision', customer: 'customer' };
            const sentimentMap = { positive: 'positive', neutral: 'neutral', negative: 'negative' };
            const sentimentLabelMap = { positive: 'positivo', neutral: 'neutro', negative: 'negativo' };

            const leads = clients.map(c => {
                const initials = c.name.split(' ').slice(0, 2).map(n => (n[0] || '').toUpperCase()).join('');
                return {
                    initials,
                    name: c.name,
                    procedure: c.concerns?.[0] || 'Mesoterapia',
                    hairLossType: c.hairCondition || '—',
                    stage: stageMap[c.funnelStage] || 'awareness',
                    stageLabel: c.funnelStage || 'awareness',
                    sentiment: sentimentMap[c.sentiment] || 'neutral',
                    sentimentLabel: sentimentLabelMap[c.sentiment] || 'neutro',
                    objection: (c.objections || [])[0] || '—',
                    lastInteraction: c.lastUpdated ? timeAgo(c.lastUpdated) : '—',
                };
            });

            const scheduled = clients.filter(c => c.funnelStage === 'customer' || c.funnelStage === 'decision').length;
            return json(200, {
                totalLeads: clients.length,
                scheduled,
                avgTicket: '820',
                potentialRevenue: `${(clients.length * 820 / 1000).toFixed(1)}k`,
                leads,
            });
        }

        // ── GET /api/dashboard/appointments ──
        if (req.method === 'GET' && req.url === '/api/dashboard/appointments') {
            const d = getDashboardData(rateLimits, messageQueues);
            const today = new Date().toISOString().slice(0, 10);
            let todayAppts = [];
            try {
                const db = require('./database');
                todayAppts = db.getAppointmentsByDate(today) || [];
            } catch (e) { /* no db */ }

            const confirmed = todayAppts.filter(a => a.status === 'confirmed').length;
            const pending = todayAppts.filter(a => a.status === 'pending').length;

            const todayFormatted = todayAppts.map(a => ({
                time: a.time || '—',
                client: a.name || a.phone || '—',
                procedure: a.type || 'Consulta',
                status: a.status || 'pending',
                statusLabel: a.status === 'confirmed' ? 'confirmado' : a.status === 'cancelled' ? 'cancelado' : 'pendente',
            }));

            const procDist = {};
            todayAppts.forEach(a => { const t = a.type || 'Consulta'; procDist[t] = (procDist[t] || 0) + 1; });

            return json(200, {
                confirmed,
                pending,
                noShow30d: 0,
                nextTime: todayFormatted[0]?.time || '—',
                today: todayFormatted,
                procedureDistribution: Object.keys(procDist).length ? procDist : { Mesoterapia: 0, PRP: 0, Transplante: 0 },
            });
        }

        // ── GET /api/dashboard/kpis ──
        if (req.method === 'GET' && req.url === '/api/dashboard/kpis') {
            const d = getDashboardData(rateLimits, messageQueues);
            const kpis = d.overview;
            const responseTimes = d.responseTimes || [];
            const latencyLabels = d.hourlyVolume.labels;
            const latencyData = latencyLabels.map((_, i) => {
                const rt = responseTimes[i];
                return rt ? (rt / 1000).toFixed(1) : 0;
            });

            const sentPos = d.sentiment.positive || 0;
            const sentNeu = d.sentiment.neutral || 0;
            const sentNeg = d.sentiment.negative || 0;
            const sentTotal = sentPos + sentNeu + sentNeg || 1;

            return json(200, {
                avgResponseTime: kpis.avgResponseTimeSec,
                totalMessages7d: kpis.totalMessages || '—',
                tokensUsedWeek: '—',
                bookingRate: kpis.conversionRate || 0,
                latencyLabels,
                latencyData,
                sentimentHistory: {
                    labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
                    positive: Array(7).fill(Math.round((sentPos / sentTotal) * 100)),
                    neutral: Array(7).fill(Math.round((sentNeu / sentTotal) * 100)),
                    negative: Array(7).fill(Math.round((sentNeg / sentTotal) * 100)),
                },
                intentDistribution: d.intentDistribution || {},
                details: {
                    'Msgs processadas hoje': String(kpis.totalMessages || 0),
                    'Tempo mais rápido': `${((d.performance.minLatency || 0) / 1000).toFixed(1)}s`,
                    'Tempo mais lento': `${((d.performance.maxLatency || 0) / 1000).toFixed(1)}s`,
                    'Erros OpenAI': String(d.performance.totalErrors || 0),
                    'Msgs com áudio': `${d.mediaTypes?.audio || 0} (${kpis.totalMessages ? Math.round(((d.mediaTypes?.audio || 0) / kpis.totalMessages) * 100) : 0}%)`,
                    'Rate limits ativados': String(d.rateLimits?.blockedUsers || 0),
                    'Tokens OpenAI hoje': '—',
                    'Fallback rate': `${kpis.escalationRate || 0}%`,
                },
            });
        }

        // ── GET /api/dashboard/ab-test ──
        if (req.method === 'GET' && req.url === '/api/dashboard/ab-test') {
            const d = getDashboardData(rateLimits, messageQueues);
            const ab = d.abTesting || {};
            const variants = ab.variants || {};
            const variantList = Object.entries(variants).map(([id, v]) => ({
                id,
                name: v.name || `Variante ${id}`,
                description: v.description || '',
                bookingRate: v.bookingRate || v.conversionRate || 0,
                avgSentiment: v.avgSentiment || 0,
                escalations: v.escalationRate || 0,
            }));

            return json(200, {
                testName: ab.testName || 'Estilo de resposta',
                confidence: ab.confidence || 0,
                totalSamples: ab.totalAssignments || 0,
                variants: variantList.length ? variantList : [
                    { id: 'A', name: 'Empática', description: 'Respostas com empatia', bookingRate: 0, avgSentiment: 0, escalations: 0 },
                    { id: 'B', name: 'Direta', description: 'Respostas diretas', bookingRate: 0, avgSentiment: 0, escalations: 0 },
                ],
                alert: ab.winner ? { type: 'teal', message: `Variante ${ab.winner} é a vencedora!` } : null,
                history: { labels: ['Dia 1', 'Dia 2', 'Dia 3', 'Dia 4', 'Dia 5', 'Dia 6', 'Dia 7'], A: Array(7).fill(0), B: Array(7).fill(0) },
            });
        }

        // ── GET /api/dashboard/system ──
        if (req.method === 'GET' && req.url === '/api/dashboard/system') {
            const d = getDashboardData(rateLimits, messageQueues);
            const perf = d.performance;
            const heal = d.selfHealing;
            const health = await runHealthChecks();

            const circuitBreakers = Object.entries(health).map(([key, svc]) => ({
                name: svc.label || key,
                p95: svc.latencyMs ? `${(svc.latencyMs / 1000).toFixed(1)}s` : '—',
                errors: svc.status === 'error' ? 1 : 0,
                state: svc.status === 'online' ? 'CLOSED' : svc.status === 'warning' ? 'HALF' : 'OPEN',
            }));

            const healLog = (heal.recentEvents || []).slice(0, 10).map(e => ({
                time: e.timestamp ? new Date(e.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—',
                type: e.type || 'Retry',
                message: e.message || e.error || '—',
                resolved: e.recovered ?? e.resolved ?? false,
            }));

            const latencyLog = perf.latencyLog || [];
            const latencyLabels = Array.from({ length: 24 }, (_, i) => `${i}h`);
            const latencyData = latencyLabels.map((_, i) => {
                const entry = latencyLog.find(l => new Date(l.timestamp || 0).getHours() === i);
                return entry ? (entry.latency / 1000).toFixed(1) : 0;
            });

            const allHealthy = circuitBreakers.every(cb => cb.state === 'CLOSED');

            return json(200, {
                avgLatency: perf.avgLatencySec || '0',
                uptime30d: '99.8',
                selfHealingEvents: heal.totalAttempts || 0,
                errorRate: perf.errorRate || '0',
                allHealthy,
                alertMessage: allHealthy ? '' : 'Algum serviço com problemas',
                circuitBreakers,
                selfHealingLog: healLog,
                latencyHistory: { labels: latencyLabels, data: latencyData },
            });
        }

        // ── GET /api/dashboard/security ──
        if (req.method === 'GET' && req.url === '/api/dashboard/security') {
            const d = getDashboardData(rateLimits, messageQueues);
            const sec = d.security;
            const lgpd = d.lgpd;
            const auditLogs = d.recentAudit || [];

            const auditFormatted = auditLogs.slice(0, 20).map(log => {
                const typeMap = { INPUT_SANITIZED: 'BLOCK', TOPIC_BLOCKED: 'TOPIC', LGPD_CONSENT: 'LGPD', RATE_LIMITED: 'RATE', MSG_RECEIVED: 'OK' };
                return {
                    time: log.timestamp ? new Date(log.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—',
                    type: typeMap[log.action] || log.action?.substring(0, 6) || 'OK',
                    message: `[${log.action || ''}] ${log.details || ''}`.substring(0, 100),
                    result: log.action?.includes('BLOCK') ? 'bloqueado' : log.action?.includes('TOPIC') ? 'filtrado' : 'ok',
                };
            });

            return json(200, {
                sanitized: sec.totalSanitized || 0,
                injections: sec.injectionAttempts || 0,
                topicsBlocked: sec.topicBlocked || 0,
                lgpdConsents: lgpd.consentsTracked || 0,
                auditLog: auditFormatted,
                lgpdStats: {
                    [`Ações auditadas (${lgpd.auditActionTypes || 0} tipos)`]: 'ativo',
                    'Consentimentos registrados': String(lgpd.consentsTracked || 0),
                    'Solicit. exportação': String(lgpd.exportRequests || 0),
                    'Solicit. exclusão': String(lgpd.deleteRequests || 0),
                    'Rate limit 10 msgs/min': 'ativo',
                },
            });
        }

        // ── GET /api/dashboard/knowledge-base ──
        if (req.method === 'GET' && req.url === '/api/dashboard/knowledge-base') {
            const kbData = safeCallIndex(() => {
                if (typeof knowledgeBase.getReport === 'function') return knowledgeBase.getReport();
                return { totalDocuments: knowledgeBase.documents?.length || 0, queryCount: 0, gaps: [] };
            }, { totalDocuments: 0, queryCount: 0, gaps: [] });

            const docs = (knowledgeBase.documents || []).map(doc => ({
                title: doc.title,
                updatedAt: doc.updatedAt || '—',
                hits: doc.hits || 0,
            }));

            const gaps = (kbData.gaps || []).map(g => ({
                question: g.question || g,
                count: g.count || 1,
            }));

            return json(200, {
                totalDocs: docs.length,
                queriesToday: kbData.queryCount || 0,
                documents: docs,
                gaps,
            });
        }

        // ── POST /api/dashboard/knowledge-base ── (add document)
        if (req.method === 'POST' && req.url === '/api/dashboard/knowledge-base') {
            if (user.role === 'visualizador') return json(403, { error: 'Visualizador não pode adicionar documentos' });
            const body = await readBody();
            if (!body.question || !body.answer) return json(400, { error: 'Campos question e answer são obrigatórios' });

            try {
                const docId = 'custom_' + Date.now();
                const newDoc = {
                    id: docId,
                    title: body.question,
                    content: body.answer,
                    updatedAt: new Date().toLocaleDateString('pt-BR'),
                    hits: 0,
                };
                if (typeof knowledgeBase.addDocument === 'function') {
                    await knowledgeBase.addDocument(newDoc);
                } else {
                    knowledgeBase.documents = knowledgeBase.documents || [];
                    knowledgeBase.documents.push(newDoc);
                    // Try to generate embedding
                    if (typeof knowledgeBase.getEmbedding === 'function') {
                        try {
                            knowledgeBase.documentEmbeddings = knowledgeBase.documentEmbeddings || {};
                            knowledgeBase.documentEmbeddings[docId] = await knowledgeBase.getEmbedding(body.answer, docId);
                        } catch (e) { console.warn('⚠️ Falha no embedding:', e.message); }
                    }
                    // Save to file
                    if (typeof knowledgeBase.saveDocuments === 'function') {
                        knowledgeBase.saveDocuments();
                    } else {
                        try {
                            const kbFile = path.join(__dirname, 'knowledge_base.json');
                            fs.writeFileSync(kbFile, JSON.stringify(knowledgeBase.documents, null, 2));
                        } catch (e) { /* ignore */ }
                    }
                }
                return json(201, { success: true, id: docId });
            } catch (e) {
                return json(500, { error: e.message });
            }
        }

        // ── POST /api/dashboard/conversations/:id/handoff ──
        if (req.method === 'POST' && req.url.match(/^\/api\/dashboard\/conversations\/([^/]+)\/handoff$/)) {
            if (user.role === 'visualizador') return json(403, { error: 'Visualizador não pode assumir conversas' });
            const phone = req.url.match(/\/conversations\/([^/]+)\/handoff/)[1];

            try {
                conversationManager.initializeConversation(phone);
                const state = conversationManager.states[phone];
                state.mode = 'manual';
                state.sofiaActive = false;
                state.humanEngaged = true;
                state.humanTakeoverTime = Date.now();

                // Notificar cliente via WhatsApp
                try {
                    await messaging.sendMessage(phone, 'Olá! A partir de agora você será atendido(a) por um de nossos especialistas. Um momento, por favor! 😊');
                } catch (e) { console.warn('⚠️ Falha ao enviar msg de handoff:', e.message); }

                auditLogger.command(phone, 'handoff_dashboard');
                wsManager.emitHandoffRequested({ clientName: state.name || phone, phone, activeCount: Object.values(conversationManager.states || {}).filter(s => s.mode === 'manual').length });

                return json(200, { success: true, message: `Conversa ${phone} em modo manual` });
            } catch (e) {
                return json(500, { error: e.message });
            }
        }

        // ── LGPD routes (authenticated) ──
        if (req.method === 'POST' && req.url === '/api/dashboard/lgpd/export') {
            const body = await readBody();
            if (!body.phone) return json(400, { error: 'Campo phone obrigatório' });
            const data = clientMemory.exportClientData(body.phone);
            auditLogger.lgpdExport(body.phone);
            return json(200, { success: true, data });
        }

        if (req.method === 'POST' && req.url === '/api/dashboard/lgpd/delete') {
            if (user.role !== 'admin') return json(403, { error: 'Apenas admin pode deletar dados' });
            const body = await readBody();
            if (!body.phone) return json(400, { error: 'Campo phone obrigatório' });
            const result = clientMemory.deleteClientData(body.phone);
            conversationManager.resetConversation(body.phone);
            auditLogger.lgpdDelete(body.phone, result);
            return json(200, { success: true });
        }

        // ── Legacy routes (from old dashboard — backward compat) ──
        if (req.method === 'GET' && req.url === '/dashboard/data') {
            const data = getDashboardData(rateLimits, messageQueues);
            return json(200, data);
        }

        if (req.method === 'GET' && req.url === '/dashboard/health-check') {
            const services = await runHealthChecks();
            return json(200, { services, timestamp: new Date().toISOString() });
        }

        if (req.method === 'GET' && req.url === '/metrics') {
            return json(200, {
                status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(),
                kpis: kpiTracker.getReport(), performance: swop.getHealthReport(),
            });
        }

        // Rota não encontrada
        res.writeHead(404, CORS);
        res.end(JSON.stringify({ error: 'Not Found' }));

    } catch (e) {
        console.error('❌ Erro no servidor:', e.message);
        if (!res.headersSent) {
            json(500, { error: 'Erro interno do servidor' });
        }
    }
});

// Helpers usados nos endpoints
function safeCallIndex(fn, fallback) {
    try { return fn() || fallback; } catch (e) { return fallback; }
}

function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'agora';
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

// ===== INICIALIZAÇÃO =====

async function start() {
    console.log('\n======================================================');
    console.log('🤖 SOFIA AGENT - QUALITY HAIR');
    console.log('📡 Modo: Webhook chat provider');
    console.log('======================================================\n');

    // Subir servidor PRIMEIRO — Railway precisa do /health respondendo rápido
    server.listen(WEBHOOK_PORT, () => {
        wsManager.init(server);
        console.log(`\n🚀 Sofia IA rodando na porta ${WEBHOOK_PORT}`);
        auditLogger.startup();
    });

    // Inicializar coisas pesadas DEPOIS, em background
    try {
        await auth.authReady;
        console.log('🔐 Auth: Sistema de autenticação inicializado');
    } catch (err) {
        console.warn('⚠️ Auth:', err.message);
    }

    try {
        await messaging.getStatus();
    } catch (err) {
        console.warn('⚠️ Messaging:', err.message);
    }

    // KB em background — não bloqueia o boot
    knowledgeBase.initialize().catch(err => {
        console.error('⚠️ KB:', err.message);
    });

}

// Exibe relatórios a cada 5 minutos
setInterval(() => {
    try { swop.printHealthReport(); } catch(e) {}
    try { selfHealing.printReport(); } catch(e) {}
    try { kpiTracker.printReport(); } catch(e) {}
    try { abTesting.printReport(); } catch(e) {}
}, 5 * 60 * 1000);

// P3: Monitoramento de memória a cada 1 minuto
const { chatHistories } = (() => { try { return require('./ai'); } catch(e) { return {}; } })();
setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const activeUsers = chatHistories ? Object.keys(chatHistories).length : 0;
    console.log(`📊 Mem: ${heapUsedMB}MB/${heapTotalMB}MB | Usuários: ${activeUsers} | Uptime: ${Math.round(process.uptime() / 60)}min`);
    if (heapUsedMB > 400) {
        console.warn(`⚠️ Uso de memória alto: ${heapUsedMB}MB`);
    }
}, 60000);

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Encerrando Sofia Agent...');
    auditLogger.shutdown();
    auditLogger.destroy();
    conversationManager.destroy();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Encerrando Sofia Agent (SIGTERM)...');
    auditLogger.shutdown();
    auditLogger.destroy();
    conversationManager.destroy();
    server.close();
    process.exit(0);
});

// Captura erros não tratados para evitar crash
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error.message);
    // NÃO mata o processo — mantém container vivo no Railway
});

// Inicia o servidor
start();
