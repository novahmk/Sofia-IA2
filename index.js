const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const http = require('http');
const { getSofiaResponse } = require('./ai');
const { transcribeAudioFromUrl, detectMediaTypeFromMime, createAudioContext } = require('./audioProcessor');
const conversationManager = require('./conversationManager');
const knowledgeBase = require('./knowledgeBase');
const swop = require('./swop');
const selfHealing = require('./selfHealing');
const inputSanitizer = require('./inputSanitizer');
const clientMemory = require('./clientMemory');
const MessagingClient = require('./messagingClient');
const kpiTracker = require('./kpiTracker');
const intentFlow = require('./intentFlow');
const topicBlacklist = require('./topicBlacklist');
const auditLogger = require('./auditLogger');
const abTesting = require('./abTesting');

// Inicializa o client de mensagens (implemente com sua API)
const messaging = new MessagingClient();

// Lista de números de admin autorizados a usar comandos de controle
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

// Porta do servidor webhook
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000', 10);

// Fila de mensagens por usuário para garantir ordem de processamento
const messageQueues = {};

// Rate limiting por usuário (anti-spam)
const rateLimits = {};
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minuto
const RATE_LIMIT_MAX_MESSAGES = 10; // máximo de mensagens por janela

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
                        { phoneNumber: userPhone, operation: 'audio_transcription' }
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
            const healing = await selfHealing.analyze(error, null, { phoneNumber: userPhone, operation: 'process_message' });
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
const server = http.createServer((req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
    }

    // Métricas completas
    if (req.method === 'GET' && req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            kpis: kpiTracker.getReport(),
            intentFlow: intentFlow.getReport(),
            abTesting: abTesting.getReport(),
            topicBlacklist: topicBlacklist.getReport(),
            performance: swop.getHealthReport(),
            selfHealing: selfHealing.getReport(),
            security: inputSanitizer.getReport(),
            rateLimits: {
                activeUsers: Object.keys(rateLimits).length,
                blockedUsers: Object.values(rateLimits).filter(r => r.blocked).length
            },
            queues: {
                activeConversations: Object.keys(messageQueues).length
            }
        }, null, 2));
        return;
    }

    // Logs de auditoria
    if (req.method === 'GET' && req.url?.startsWith('/audit')) {
        const urlObj = new URL(req.url, `http://localhost:${WEBHOOK_PORT}`);
        const phone = urlObj.searchParams.get('phone');
        const limit = parseInt(urlObj.searchParams.get('limit') || '100', 10);
        const logs = auditLogger.query(phone, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs, null, 2));
        return;
    }

    // LGPD — Direito ao esquecimento e portabilidade de dados
    if (req.method === 'POST' && req.url === '/lgpd/delete') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { phone } = JSON.parse(body);
                if (!phone) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Campo "phone" obrigatório' }));
                    return;
                }
                const result = clientMemory.deleteClientData(phone);
                conversationManager.resetConversation(phone);
                auditLogger.lgpdDelete(phone, result);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/lgpd/export')) {
        const urlObj = new URL(req.url, `http://localhost:${WEBHOOK_PORT}`);
        const phone = urlObj.searchParams.get('phone');
        if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Parâmetro "phone" obrigatório' }));
            return;
        }
        const data = clientMemory.exportClientData(phone);
        auditLogger.lgpdExport(phone);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
        return;
    }

    // Webhook do Twilio WhatsApp
    if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        
        req.on('data', chunk => { body += chunk; });
        
        req.on('end', () => {
            // Responder 200 imediatamente (Twilio exige resposta rápida)
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end('<Response></Response>');

            try {
                // Twilio envia dados como application/x-www-form-urlencoded
                const params = new URLSearchParams(body);
                const from = params.get('From') || '';        // whatsapp:+5511999999999
                const msgBody = params.get('Body') || '';
                const numMedia = parseInt(params.get('NumMedia') || '0', 10);
                const messageSid = params.get('MessageSid') || '';

                // Extrair número limpo (remover "whatsapp:" prefixo e "+")
                const userPhone = from.replace('whatsapp:', '').replace('+', '');
                if (!userPhone) return;

                console.log(`\n📩 Webhook Twilio recebido de ${userPhone} | SID: ${messageSid}`);

                // Montar dados no formato que processIncomingMessage espera
                const webhookData = {
                    phone: userPhone,
                    fromMe: false,
                    isGroup: false,
                    text: { message: msgBody, body: msgBody }
                };

                // Verificar mídias (áudio, imagem, etc.)
                if (numMedia > 0) {
                    const mediaType = (params.get('MediaContentType0') || '').toLowerCase();
                    const mediaUrl = params.get('MediaUrl0') || '';

                    if (mediaType.startsWith('audio/')) {
                        webhookData.audio = { audioUrl: mediaUrl, fileUrl: mediaUrl, url: mediaUrl };
                    } else if (mediaType.startsWith('image/')) {
                        webhookData.image = { imageUrl: mediaUrl };
                    } else if (mediaType.startsWith('video/')) {
                        webhookData.video = { videoUrl: mediaUrl };
                    } else {
                        webhookData.document = { documentUrl: mediaUrl };
                    }
                }

                processIncomingMessage(webhookData);

            } catch (parseError) {
                console.error('❌ Erro ao parsear webhook Twilio:', parseError.message);
            }
        });
        
        return;
    }

    // Rota não encontrada
    res.writeHead(404);
    res.end('Not Found');
});

// ===== INICIALIZAÇÃO =====

async function start() {
    console.log('\n======================================================');
    console.log('🤖 SOFIA AGENT - QUALITY HAIR');
    console.log('📡 Modo: Twilio WhatsApp Webhook');
    console.log('======================================================\n');

    // Verificar status do cliente de mensagens
    try {
        const status = await messaging.getStatus();
        console.log('📱 Status Messaging:', JSON.stringify(status));
    } catch (err) {
        console.warn(`⚠️ Não foi possível verificar status do messaging: ${err.message}`);
    }

    // Inicializar base de conhecimento
    try {
        await knowledgeBase.initialize();
    } catch (err) {
        console.error('⚠️ Falha ao inicializar KB:', err.message);
    }

    // Subir servidor webhook
    server.listen(WEBHOOK_PORT, () => {
        console.log(`\n🌐 Webhook server rodando na porta ${WEBHOOK_PORT}`);
        console.log(`   POST http://localhost:${WEBHOOK_PORT}/webhook`);
        console.log(`   GET  http://localhost:${WEBHOOK_PORT}/health`);
        console.log(`   GET  http://localhost:${WEBHOOK_PORT}/metrics`);
        console.log(`   POST http://localhost:${WEBHOOK_PORT}/lgpd/delete`);
        console.log(`   GET  http://localhost:${WEBHOOK_PORT}/lgpd/export?phone=...`);
        console.log(`   GET  http://localhost:${WEBHOOK_PORT}/audit?phone=...&limit=100`);
        console.log('\n✅ Sofia está pronta para atender!');
        auditLogger.startup();
        console.log('📌 Configure a URL do webhook na sua API de mensagens:');
        console.log(`   https://seu-dominio.com/webhook\n`);
    });
}

// Exibe relatórios a cada 5 minutos
setInterval(() => {
    swop.printHealthReport();
    selfHealing.printReport();
    kpiTracker.printReport();
    abTesting.printReport();
}, 5 * 60 * 1000);

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
    console.error('💀 Erro fatal. Encerrando...');
    process.exit(1);
});

// Inicia o servidor
start();
