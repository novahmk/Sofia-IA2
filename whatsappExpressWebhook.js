// ── Crash handlers — NÃO deixa o processo morrer ──
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
  // NÃO deixa o processo morrer
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  // NÃO deixa o processo morrer
});

require('dotenv').config();

function assertRequiredEnv(names) {
  const missing = names.filter((name) => !process.env[name] || !String(process.env[name]).trim());
  if (missing.length === 0) {
    return;
  }

  console.error(`❌ [BOOT] Variáveis obrigatórias ausentes: ${missing.join(', ')}`);
  console.error('❌ [BOOT] Configure as variáveis no Railway em Service > Variables ou no arquivo .env local antes de iniciar o servidor.');
  process.exit(1);
}

assertRequiredEnv(['OPENAI_API_KEY']);

console.log('📌 [BOOT] Iniciando imports...');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
console.log('📌 [BOOT] express/axios/crypto OK');

// ── Módulos da Sofia (try/catch para não crashar o boot) ──
let getSofiaResponse = null;
let inputSanitizer = null;
let topicBlacklist = null;
let conversationManager = null;
let clientMemory = null;
let kpiTracker = null;
let auditLogger = null;
let knowledgeBase = null;
let intentFlow = null;
const agentContext = require('./agents/agentContext');
const supervisor = require('./agents/supervisor');
const leadMemory = require('./leadSystem/leadMemory');
const eventBus = require('./eventBus');
const selfImprovement = require('./improvement/selfImprovement');
const messageQueue = require('./messageQueue');
const healthMonitor = require('./healthMonitor');
const responseCache = require('./responseCache');
const { jaFoiProcessada, marcarComoProcessada, salvarMensagem } = require('./conversationDB');
const { carregarHistorico, getHorasDeContextoFrio } = require('./conversationDB');
const leadDB = require('./leadDB');
const { chamarIA } = require('./sdrAI');
const calendarService = require('./calendar');
const db = require('./database');

try {
  const ai = require('./ai');
  getSofiaResponse = ai.getSofiaResponse;
  console.log('📌 [BOOT] ai.js OK (Sofia completa)');
} catch (e) {
  console.warn('⚠️ [BOOT] ai.js falhou:', e.message);
}

try { inputSanitizer = require('./utils/inputSanitizer'); console.log('📌 [BOOT] inputSanitizer OK'); } catch (e) { console.warn('⚠️ [BOOT] inputSanitizer falhou:', e.message); }
try { topicBlacklist = require('./topicBlacklist'); console.log('📌 [BOOT] topicBlacklist OK'); } catch (e) { console.warn('⚠️ [BOOT] topicBlacklist falhou:', e.message); }
try { conversationManager = require('./core/conversationManager'); console.log('📌 [BOOT] conversationManager OK'); } catch (e) { console.warn('⚠️ [BOOT] conversationManager falhou:', e.message); }
try { clientMemory = require('./clientMemory'); console.log('📌 [BOOT] clientMemory OK'); } catch (e) { console.warn('⚠️ [BOOT] clientMemory falhou:', e.message); }
try { kpiTracker = require('./kpiTracker'); console.log('📌 [BOOT] kpiTracker OK'); } catch (e) { console.warn('⚠️ [BOOT] kpiTracker falhou:', e.message); }
try { auditLogger = require('./utils/auditLogger'); console.log('📌 [BOOT] auditLogger OK'); } catch (e) { console.warn('⚠️ [BOOT] auditLogger falhou:', e.message); }
try { knowledgeBase = require('./knowledgeBase'); console.log('📌 [BOOT] knowledgeBase OK'); } catch (e) { console.warn('⚠️ [BOOT] knowledgeBase falhou:', e.message); }
try { intentFlow = require('./intentFlow'); console.log('📌 [BOOT] intentFlow OK'); } catch (e) { console.warn('⚠️ [BOOT] intentFlow falhou:', e.message); }

console.log('📌 [BOOT] Imports concluídos');

// ── Auto-migrations: cria tabelas no PostgreSQL automaticamente no boot ──
if (process.env.DATABASE_URL) {
  require('./migrations').runMigrations()
    .then(() => console.log('🗄️  Migrations concluídas'))
    .catch(e => console.warn('⚠️ Migrations falhou (não crítico):', e.message));
}

// ── Configuração ──
const app = express();
const PORT = process.env.PORT || 8080;

const WEBHOOK_SECRET = process.env.WASENDERAPI_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WASENDERAPI_BASE_URL = process.env.WASENDERAPI_BASE_URL || 'https://www.wasenderapi.com/api';
const WASENDERAPI_TOKEN = process.env.WASENDERAPI_TOKEN || process.env.API_ACCESS_TOKEN;

function createFallbackMessageId(from, texto, audioUrl) {
  const fingerprint = String(texto || audioUrl || 'sem-conteudo').trim();
  const timeBucket = Math.floor(Date.now() / 5000);
  return crypto
    .createHash('md5')
    .update(`${from}|${fingerprint}|${timeBucket}`)
    .digest('hex');
}

function shouldBypassResponseCache(intention, hasSchedulingInProgress) {
  if (hasSchedulingInProgress || intention?.agent === 'administrative') {
    return true;
  }

  return false;
}

// ── Fallback OpenAI (caso ai.js não carregue) ──
let _openai = null;
function getFallbackOpenAI() {
  if (!_openai) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada');
    const { OpenAI } = require('openai');
    _openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return _openai;
}

function fallbackResponse(userText) {
  return getFallbackOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Você é Sofia, consultora da Clínica Quality Hair (Vila Mariana, SP). Responda em português brasileiro, curta e amigável. Máximo 3 frases.' },
      { role: 'user', content: userText },
    ],
    max_tokens: 300,
    temperature: 0.7,
  }).then(c => c.choices?.[0]?.message?.content?.trim());
}

// ── Middleware ──
function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) req.rawBody = buf.toString(encoding || 'utf8');
}
app.use(express.json({ verify: rawBodySaver, limit: '1mb' }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver, limit: '1mb' }));

// ── express-rate-limit: proteção HTTP contra flood ──
const rateLimit = require('express-rate-limit');
// Limita /webhook a 60 req/min por IP (proteção global)
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
  handler: (req, res) => {
    console.warn(`🚫 [HTTP rate-limit] IP ${req.headers['x-forwarded-for'] || req.socket?.remoteAddress}`);
    res.status(429).json({ error: 'Too Many Requests' });
  },
});

// ── Auth ──
function safeCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function authenticateWebhookRequest(req) {
  if (!WEBHOOK_SECRET) return true;
  const signature = req.header('x-webhook-signature') || '';
  if (safeCompare(signature, WEBHOOK_SECRET)) return true;
  console.warn('⁉️ Webhook rejeitado: X-Webhook-Signature inválido');
  return false;
}

// ── Envio via WASenderAPI ──
async function enviarMensagem(to, text) {
  if (!WASENDERAPI_TOKEN) throw new Error('WASENDERAPI_TOKEN não configurado!');
  const sendUrl = `${WASENDERAPI_BASE_URL.replace(/\/$/, '')}/send-message`;

  console.log(`📤 WASenderAPI: ${sendUrl} → ${to}`);
  try {
    const response = await axios.post(sendUrl, { to, text }, {
      headers: { Authorization: `Bearer ${WASENDERAPI_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    console.log(`✅ WASenderAPI: HTTP ${response.status}`);
    return response.data;
  } catch (axiosError) {
    console.error(`❌ WASenderAPI FALHOU: ${axiosError.response?.status || 'sem response'}`);
    console.error(`  Body: ${JSON.stringify(axiosError.response?.data || axiosError.message)}`);
    throw axiosError;
  }
}

// ── Rate limiter por telefone ──
const rateLimits = {};
function checkRateLimit(phone) {
  const now = Date.now();
  if (!rateLimits[phone]) rateLimits[phone] = [];
  rateLimits[phone] = rateLimits[phone].filter(t => now - t < 60000);
  if (rateLimits[phone].length >= 10) return false;
  rateLimits[phone].push(now);
  return true;
}

// ── Rate limiter por IP ──
const ipRateLimits = {};
function checkIpRateLimit(ip) {
  const now = Date.now();
  if (!ipRateLimits[ip]) ipRateLimits[ip] = [];
  ipRateLimits[ip] = ipRateLimits[ip].filter(t => now - t < 60000);
  if (ipRateLimits[ip].length >= 100) return false;
  ipRateLimits[ip].push(now);
  return true;
}

// ── Rotas ──
app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', async (req, res) => {
  try {
    const { summary } = await healthMonitor.runMonitoringCheck({ force: false, notify: false });
    const routerMode = process.env.OPENAI_API_KEY ? 'openai' : 'heuristic';
    const aiMode = getSofiaResponse ? 'full' : 'fallback';
    const calendarMode = [
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
      process.env.GOOGLE_CLIENT_ID,
    ].some(Boolean)
      ? 'configured'
      : 'missing';

    res.json({
      status: summary.status,
      server: summary.server,
      openai: summary.openai,
      messaging: summary.messaging,
      database: summary.database,
      calendar: summary.calendar,
      timestamp: summary.timestamp,
      time: Date.now(),
      uptime: Math.floor(process.uptime()),
      nodeEnv: process.env.NODE_ENV || 'development',
      ai: {
        mode: aiMode,
        available: Boolean(getSofiaResponse),
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      },
      router: {
        mode: routerMode,
        model: process.env.OPENAI_ROUTER_MODEL || 'gpt-4o-mini',
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      },
      integrations: {
        wasenderapi: Boolean(process.env.WASENDERAPI_TOKEN),
        database: Boolean(process.env.DATABASE_URL),
        redis: Boolean(process.env.REDIS_URL),
        calendar: {
          mode: calendarMode,
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        },
      },
      monitoring: healthMonitor.getMonitoringSnapshot(),
      services: summary.services,
      queue: require('./messageQueue').getStats(),
      cache: require('./responseCache').getStats(),
    });
  } catch (error) {
    console.error(`❌ /health falhou: ${error.message}`);
    res.status(500).json({
      status: 'error',
      server: 'ok',
      openai: 'error',
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

app.post('/ping', async (req, res) => {
  const pingToken = healthMonitor.getPingToken();
  if (!pingToken) {
    return res.status(503).json({ error: 'MONITORING_PING_TOKEN não configurado' });
  }

  const authHeader = String(req.header('authorization') || '');
  const providedToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!safeCompare(providedToken, pingToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { summary } = await healthMonitor.runMonitoringCheck({ force: true, notify: false });
    const monitorMessage = healthMonitor.formatMonitorMessage(summary, 'ping');
    const notification = await healthMonitor.sendMonitorMessage(monitorMessage, enviarMensagem);

    return res.json({
      status: summary.status,
      server: summary.server,
      openai: summary.openai,
      messaging: summary.messaging,
      database: summary.database,
      calendar: summary.calendar,
      timestamp: summary.timestamp,
      notification,
      services: summary.services,
    });
  } catch (error) {
    console.error(`❌ /ping falhou: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><title>Sofia IA</title>
<style>body{font-family:Arial,sans-serif;background:#f4f4f9;color:#222;padding:24px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.08);max-width:720px;margin:0 auto}
h1{margin-top:0} .ok{color:green} .fail{color:red}</style></head><body><div class="card">
<h1>Dashboard Sofia IA</h1>
<p>Servidor online.</p>
<ul>
<li>AI principal: <strong class="${getSofiaResponse ? 'ok' : 'fail'}">${getSofiaResponse ? '✅ Completa' : '❌ Fallback'}</strong></li>
<li>Roteador: <strong class="${OPENAI_API_KEY ? 'ok' : 'fail'}">${OPENAI_API_KEY ? '✅ OpenAI' : '❌ Heurístico'}</strong></li>
<li>OpenAI: <strong class="${OPENAI_API_KEY ? 'ok' : 'fail'}">${OPENAI_API_KEY ? '✅ Configurada' : '❌ Ausente'}</strong></li>
<li>WASenderAPI: <strong class="${WASENDERAPI_TOKEN ? 'ok' : 'fail'}">${WASENDERAPI_TOKEN ? '✅ Configurada' : '❌ Ausente'}</strong></li>
<li>Banco: <strong class="${process.env.DATABASE_URL ? 'ok' : 'fail'}">${process.env.DATABASE_URL ? '✅ Configurado' : '❌ Fallback local'}</strong></li>
<li>Sanitizer: <strong class="${inputSanitizer ? 'ok' : 'fail'}">${inputSanitizer ? '✅' : '❌'}</strong></li>
<li>KB: <strong class="${knowledgeBase ? 'ok' : 'fail'}">${knowledgeBase ? '✅' : '❌'}</strong></li>
</ul></div></body></html>`);
});

app.get('/webhook', (req, res) => {
  res.status(200).json({ status: 'ok', webhook: 'active' });
});

app.get('/auth/google/login', async (req, res) => {
  try {
    const authStatus = await calendarService.getAuthStatus();
    if (authStatus.mode === 'service-account') {
      return res.status(200).json({
        mode: authStatus.mode,
        connected: authStatus.connected,
        message: 'Google Calendar configurado com conta de serviço. Login OAuth não é necessário.',
        calendar_id: authStatus.calendar_id,
        service_account_file: authStatus.service_account_file,
      });
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const authUrl = calendarService.getGoogleAuthUrl(state);
    return res.redirect(authUrl);
  } catch (error) {
    console.error('❌ OAuth login Google falhou:', error.message);
    return res.status(500).json({
      error: error.message,
      required_env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const frontendUrl = calendarService.getFrontendUrl();

  try {
    const authStatus = await calendarService.getAuthStatus();
    if (authStatus.mode === 'service-account') {
      return res.redirect(`${frontendUrl}/?google_auth=not_required`);
    }
  } catch (error) {
    console.error('❌ Status do Google Calendar falhou:', error.message);
  }

  if (req.query.error) {
    const errorMessage = String(req.query.error);
    return res.redirect(`${frontendUrl}/?google_auth=error&reason=${encodeURIComponent(errorMessage)}`);
  }

  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    await calendarService.handleOAuthCallback(code);
    return res.redirect(`${frontendUrl}/?google_auth=success`);
  } catch (error) {
    console.error('❌ OAuth callback Google falhou:', error.message);
    return res.redirect(`${frontendUrl}/?google_auth=error&reason=${encodeURIComponent(error.message)}`);
  }
});

app.get('/auth/google/status', async (req, res) => {
  try {
    const status = await calendarService.getAuthStatus();
    return res.status(200).json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── FASE 2: Dashboard API (SSE + REST) ──
app.use('/api', require('./dashboardApi'));

// ── POST /webhook — Processamento principal ──
app.post('/webhook', webhookRateLimiter, async (req, res) => {
  const reqId = Date.now().toString(36);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📨 [${reqId}] WEBHOOK - ${new Date().toISOString()}`);

  // P2: Validação de Content-Type
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type deve ser application/json' });
  }

  // P1: Rate limit por IP
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkIpRateLimit(clientIp)) {
    console.warn(`🚫 [${reqId}] IP rate limit: ${clientIp}`);
    return res.status(429).json({ error: 'Too Many Requests' });
  }

  // STEP 1: Auth
  if (!authenticateWebhookRequest(req)) {
    console.error(`🚫 [${reqId}] Auth FALHOU`);
    return res.status(403).json({ status: 'unauthorized' });
  }

  // Responder 200 imediatamente
  res.status(200).json({ status: 'received' });

  try {
    // STEP 2: Evento
    // WasenderAPI dispara múltiplos eventos por mensagem (upsert, update, sent, chats.update...).
    // Só processamos a mensagem real — o restante são notificações internas.
    const event = req.body.event;
    const EVENTOS_IGNORADOS = new Set([
      'messages.upsert',          // duplicata — mesma msg já veio sem event
      'message.sent',             // eco da mensagem enviada pelo bot
      'messages.update',          // confirmação de entrega/leitura
      'chats.update',             // metadados do chat
      'contacts.update',          // atualização de contato
      'messages-personal.received', // duplicata do formato principal
    ]);
    if (event && EVENTOS_IGNORADOS.has(event)) {
      console.log(`⏭️ [${reqId}] Evento "${event}" ignorado`);
      return;
    }

    // STEP 3: Extrair remetente e texto
    let from = null;
    let texto = null;
    let pushName = 'Cliente';
    let audioUrl = null;
    let audioMessage = null;  // objeto completo para descriptografia via API
    let webhookSessionId = null;
    let messageId = null;     // ID único da mensagem para deduplicação

    // Formato WASenderAPI (messages.received ou sem event)
    if (req.body.data?.messages) {
      const msg = req.body.data.messages;
      const key = msg.key || {};
      from = key.cleanedSenderPn || key.senderPn || key.remoteJid;
      texto = msg.messageBody || msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      pushName = msg.pushName || req.body.data.pushName || pushName;
      webhookSessionId = req.body.sessionId || null;
      messageId = key.id || null;
      // Detectar áudio (audioMessage = gravação, pttMessage = push-to-talk)
      if (msg.message?.audioMessage || msg.message?.pttMessage) {
        const isPtt = !!msg.message.pttMessage;
        audioMessage = msg.message.audioMessage || msg.message.pttMessage;
        audioMessage._messageKey = key;
        audioMessage._type = isPtt ? 'ptt' : 'audio';  // para montar payload correto
        audioUrl = audioMessage.url || null;
      }
      // Fallback de mídia não suportada (sticker, location, contact, etc.)
      if (!texto && !audioMessage) {
        const msgTypes = Object.keys(msg.message || {}).filter(k => !['messageContextInfo', 'deviceSentMessage'].includes(k));
        if (msgTypes.length > 0) {
          console.log(`📎 [${reqId}] Mídia não suportada: ${msgTypes.join(', ')}`);
          // from ainda pode não ter barra: vamos marcar para responder depois
        }
      }
      if (key.fromMe === true) {
        console.log(`🔄 [${reqId}] fromMe, ignorando`);
        return;
      }
    }

    // Formato alternativo
    if (!from && req.body.data) {
      const data = req.body.data;
      from = data.from || data.sender || data.phone || data.number;
      texto = data.message || data.body || data.text || data.messageBody;
      pushName = data.pushName || pushName;
    }

    // Formato flat
    if (!from && (req.body.from || req.body.sender || req.body.phone)) {
      from = req.body.from || req.body.sender || req.body.phone;
      texto = req.body.message || req.body.body || req.body.text;
      pushName = req.body.pushName || pushName;
    }

    if (!from) {
      console.warn(`⚠️ [${reqId}] Sem from. Body: ${JSON.stringify(req.body).substring(0, 500)}`);
      return;
    }

    // Limpar número E.164 antes de qualquer envio
    from = String(from)
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@lid$/, '')
      .replace(/^whatsapp:/, '')
      .replace(/[\s()-]/g, '')
      .trim();
    if (from && !from.startsWith('+')) from = '+' + from;

    if (!messageId) {
      messageId = createFallbackMessageId(from, texto, audioUrl);
    }

    // ── Deduplicação: ignorar mensagens que já foram processadas ──
    if (await jaFoiProcessada(messageId)) {
      console.log(`⏭️ [${reqId}] Mensagem duplicada (${messageId}), ignorando`);
      return;
    }

    // Sem texto: tentar transcrever áudio ou responder fallback de mídia
    if (!texto?.trim()) {
      if (audioUrl) {
        if (process.env.OPENAI_API_KEY) {
          try {
            console.log(`🎙️ [${reqId}] Áudio de ${from} — transcrevendo via Whisper...`);
            const { transcribeAudioViaWASender } = require('./audioProcessor');
            const transcription = await transcribeAudioViaWASender({
              audioMessage,
              phoneNumber: from,
              sessionId: webhookSessionId,
              outputDir: '/tmp/sofia_audio',
              waToken: WASENDERAPI_TOKEN,
              waBaseUrl: WASENDERAPI_BASE_URL,
            });
            texto = transcription.text;
            console.log(`✅ [${reqId}] Transcrição (${transcription.language}): "${texto.substring(0, 80)}"`);
          } catch (transcribeErr) {
            console.warn(`⚠️ [${reqId}] Transcrição falhou: ${transcribeErr.message}`);
            await enviarMensagem(from, 'Recebi seu áudio! 🎙️ No momento, processo melhor mensagens de texto. Pode escrever o que precisa?');
            return;
          }
        } else {
          await enviarMensagem(from, 'Recebi seu áudio! 🎙️ No momento, processo melhor mensagens de texto. Pode escrever o que precisa?');
          return;
        }
      } else {
        // Fallback: sticker, location, contact, documento, imagem sem legenda
        if (from) {
          await enviarMensagem(from, 'Recebi sua mensagem! Por enquanto só consigo processar textos e áudios. Pode me escrever o que precisa? 😊');
        } else {
          console.warn(`⚠️ [${reqId}] Sem texto nem áudio. Body: ${JSON.stringify(req.body).substring(0, 500)}`);
        }
        return;
      }
    }

    texto = texto.trim();

    console.log(`📱 [${reqId}] De: ${from} | Msg: "${texto.substring(0, 80)}"`);

    // Rate limit
    if (!checkRateLimit(from)) {
      console.warn(`🚦 [${reqId}] Rate limit para ${from}`);
      return;
    }

    // Sanitização
    let textoLimpo = texto;
    if (inputSanitizer) {
      try {
        const sanitized = inputSanitizer.sanitize(texto, from);
        textoLimpo = sanitized.sanitized || texto;
        if (sanitized.flags?.length && auditLogger) {
          auditLogger.inputSanitized(from, sanitized.flags);
        }
      } catch (e) { /* sanitizer não essencial */ }
    }

    // Topic blacklist
    if (topicBlacklist) {
      try {
        const check = topicBlacklist.check(textoLimpo);
        if (check.blocked) {
          console.warn(`🚫 [${reqId}] Tópico bloqueado: ${check.reason}`);
          await enviarMensagem(from, check.response || 'Nosso foco é saúde capilar. Posso ajudar nessa área?');
          return;
        }
      } catch (e) { /* blacklist não essencial */ }
    }

    // STEP 4: Gerar resposta via fila serial por telefone (evita concorrência)
    console.log(`🤖 [${reqId}] Enfileirando para ${from}...`);

    // Marcar como processada antes de entrar na fila (previne retransmissões concorrentes)
    await marcarComoProcessada(messageId);
    // Persistir mensagem do usuário no histórico PostgreSQL
    await salvarMensagem(from, 'user', textoLimpo, audioUrl ? 'audio' : 'text');
    // Atualizar timestamp de contato
    await leadDB.atualizarUltimoContato(from).catch(() => {});

    selfImprovement.feedNextMessage(from, textoLimpo);
    eventBus.publish('message_received', { phone: from, nome: pushName, message: textoLimpo.substring(0, 80) });

    const startAI = Date.now();
    const result = await messageQueue.enqueue(from, async () => {
      await db.ready.catch(() => {});

      const lead = await leadDB.buscarOuCriarLead(from).catch(() => ({ status: 'novo', score: 0 }));
      const leadForRouting = {
        ...lead,
        telefone: lead?.telefone || from,
        lead_id: lead?.lead_id || from,
        nome: lead?.nome || (pushName && pushName !== 'Cliente' ? pushName : 'Cliente'),
      };
      const horasFrio = await getHorasDeContextoFrio(from);
      const memory = clientMemory?.getClientMemory ? clientMemory.getClientMemory(from) : null;
      const hasSchedulingInProgress = Boolean(memory?.pendingScheduling?.step || memory?.activeScheduling?.eventId);
      const routedIntention = await agentContext.analyzeIntentionWithAI(textoLimpo, leadForRouting);
      const shouldUseSchedulingFlow = hasSchedulingInProgress || [
        'scheduling',
        'schedule_confirmation',
        'schedule_cancellation',
        'reschedule',
      ].includes(routedIntention.type);
      const skipCache = shouldBypassResponseCache(routedIntention, hasSchedulingInProgress);

      // Cancelar follow-up pendente pois o lead respondeu
      await leadDB.cancelarFollowUpPendente(from).catch(() => {});

      if (shouldUseSchedulingFlow) {
        console.log(`📅 [${reqId}] Intenção ${routedIntention.type} detectada via OpenAI — usando supervisor diretamente`);
        const routedName = leadForRouting.nome;
        const r = await supervisor.processMessage(from, textoLimpo, routedName, routedIntention, {
          horasSemContato: horasFrio,
        });

        await leadDB.atualizarLead(from, {
          nome: r.lead?.nome,
          intencao: routedIntention.type,
          status: r.lead?.status || lead?.status,
        }).catch(() => {});

        return { response: r.response, _fromSupervisor: true, _bypassedSdr: true };
      }

      const etapa = lead?.status || lead?.etapa_funil || 'novo';
      if (!skipCache) {
        const cached = await responseCache.get(textoLimpo, etapa);
        if (cached) {
          console.log(`⚡ [${reqId}] Cache hit (${etapa}) — saltou OpenAI`);
          return { response: cached, _fromCache: true };
        }
      }

      // Carregar histórico PostgreSQL e dados de contexto
      const historico = await carregarHistorico(from, 20);
      const isPrimeiroContato = historico.filter(h => h.role === 'user').length <= 1;

      // Chamar IA com output JSON estruturado (sdrAI)
      let sdrResult;
      try {
        sdrResult = await chamarIA({ telefone: from, textoFinal: textoLimpo, historico, lead, horasFrio, isPrimeiroContato });
      } catch (sdrErr) {
        console.warn(`⚠️ [${reqId}] sdrAI falhou, fallback supervisor: ${sdrErr.message}`);
        const r = await supervisor.processMessage(from, textoLimpo, pushName || 'Cliente');
        return { response: r.response, _fromSupervisor: true };
      }

      if (sdrResult.lead_intent === 'agendamento') {
        const r = await supervisor.processMessage(from, textoLimpo, leadForRouting.nome, {
          agent: 'administrative',
          type: 'scheduling',
          source: 'sdr_redirect',
          entities: {},
        }, {
          horasSemContato: horasFrio,
        });
        return { response: r.response, _fromSupervisor: true, _fromSdrRedirect: true };
      }

      const resposta = sdrResult.texto;

      // Atualizar campos estruturados do lead
      await leadDB.atualizarLead(from, {
        status: sdrResult.lead_status,
        intencao: sdrResult.lead_intent,
        resumo_conversa: sdrResult.resumo_lead,
        score: sdrResult.score,
        nome: lead.nome || (pushName !== 'Cliente' ? pushName : undefined),
      }).catch(() => {});

      // Agendar retorno se IA detectou pedido do lead
      if (sdrResult.agendamento_retorno) {
        await leadDB.agendarRetorno(from, sdrResult.agendamento_retorno, sdrResult.resumo_lead).catch(() => {});
      }

      // Salva no cache apenas respostas não personalizadas
      const isPersonalized = lead?.nome && resposta.includes(lead.nome);
      if (resposta && !isPersonalized && !skipCache) {
        await responseCache.set(textoLimpo, etapa, resposta);
      }

      return { response: resposta, _sdrMeta: sdrResult };
    });

    const respostaIA = result.response;
    console.log(`✅ [${reqId}] resposta em ${Date.now() - startAI}ms${result._fromCache ? ' (cache)' : ''}`);

    if (!respostaIA) {
      console.error(`❌ [${reqId}] Resposta vazia`);
      return;
    }

    console.log(`💬 [${reqId}] Resposta: "${respostaIA.substring(0, 150)}"`);

    // Persistir resposta da IA no histórico PostgreSQL
    await salvarMensagem(from, 'assistant', respostaIA, 'text');

    // Tracking
    if (kpiTracker) { try { kpiTracker.recordResponse(Date.now() - startAI); } catch (e) {} }
    if (auditLogger) {
      try {
        auditLogger.msgReceived(from, textoLimpo);
        auditLogger.msgSent(from, respostaIA);
      } catch (e) {}
    }
    if (intentFlow) { try { intentFlow.recordIntent(from, textoLimpo); } catch (e) {} }

    // STEP 5: Enviar
    console.log(`📤 [${reqId}] Enviando via WASenderAPI...`);
    const startSend = Date.now();
    await enviarMensagem(from, respostaIA);
    console.log(`✅ [${reqId}] Enviado em ${Date.now() - startSend}ms`);
    console.log(`🎉 [${reqId}] COMPLETO: ${from}`);
    console.log(`${'='.repeat(60)}\n`);

  } catch (error) {
    console.error(`❌ [${reqId}] ERRO: ${error.message}`);
    if (error.response) console.error(`  HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    console.error(`  Stack: ${error.stack?.split('\n').slice(0, 4).join('\n')}`);
    console.error(`${'='.repeat(60)}\n`);
  }
});

// ── Start (PRIMEIRO — antes de qualquer inicialização pesada) ──
console.log(`📌 [BOOT] Bind 0.0.0.0:${PORT}...`);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sofia IA rodando em 0.0.0.0:${PORT}`);
  console.log(`📡 WASenderAPI: ${WASENDERAPI_BASE_URL}`);
  console.log(`🔑 Token: ${WASENDERAPI_TOKEN ? 'SIM' : '⚠️ NÃO'}`);
  console.log(`🔐 Secret: ${WEBHOOK_SECRET ? 'SIM' : '⚠️ NÃO'}`);
  console.log(`🧠 OpenAI: ${OPENAI_API_KEY ? 'SIM' : '⚠️ NÃO'}`);
  console.log(`🧭 Router: ${OPENAI_API_KEY ? 'OPENAI' : 'HEURISTIC'} (${process.env.OPENAI_ROUTER_MODEL || 'gpt-4o-mini'})`);
  console.log(`🤖 AI: ${getSofiaResponse ? 'COMPLETO (ai.js)' : 'FALLBACK (gpt-4o-mini)'}`);
  console.log(`🩺 Monitoramento: telefone ${healthMonitor.getMonitoringSnapshot().alertPhone} | token ${healthMonitor.getPingToken() ? 'SIM' : '⚠️ NÃO'}`);
  if (!OPENAI_API_KEY) console.error('🚨 OPENAI_API_KEY ausente!');
  if (!WASENDERAPI_TOKEN) console.error('🚨 WASENDERAPI_TOKEN ausente!');

  healthMonitor.startMonitoring(enviarMensagem);
});

server.on('error', (err) => {
  console.error(`💀 ERRO listen porta ${PORT}:`, err.message);
});

// ── Knowledge Base em background (não bloqueia boot) ──
if (knowledgeBase && typeof knowledgeBase.initialize === 'function') {
  setTimeout(() => {
    console.log('📚 Inicializando Knowledge Base (background)...');
    knowledgeBase.initialize()
      .then(() => console.log('✅ Knowledge Base pronta'))
      .catch(e => console.warn('⚠️ KB falhou:', e.message));
  }, 3000);
}

// ── Follow-up Cron (5s após o servidor subir) ──
setTimeout(() => {
  console.log('⏰ Cron legado de follow-up desativado; usando apenas followUpCron.');

  // Novo cron SDR (node-cron) com follow-up estruturado + retornos agendados
  try {
    const followUpCron = require('./followUpCron');
    followUpCron.init(enviarMensagem);
  } catch (e) {
    console.warn('⚠️ followUpCron não disponível:', e.message);
  }
}, 5000);

// ── Self-Improvement Analytics (a cada 6h) ──
setInterval(async () => {
  console.log('\n🔄 [SELF-IMPROVEMENT] Ciclo de analytics (6h)...');
  try {
    const selfImprovement = require('./improvement/selfImprovement');
    const stats = selfImprovement.getStats();
    console.log('📊 [SELF-IMPROVEMENT] Stats por agente:', JSON.stringify(stats.stats));
    const playbooks = require('./improvement/playbookStorage');
    const top = playbooks.getTop(5);
    if (top.length > 0) {
      console.log(`📖 [SELF-IMPROVEMENT] Top ${top.length} playbooks:`);
      top.forEach(p => console.log(`   - [${p.intentionType}] taxa: ${(p.successRate * 100).toFixed(0)}% usos: ${p.usageCount}`));
    }
  } catch (e) {
    console.warn('⚠️ [SELF-IMPROVEMENT] Ciclo falhou:', e.message);
  }
}, 6 * 60 * 60 * 1000);
