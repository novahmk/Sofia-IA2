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
const supervisor = require('./agents/supervisor');
const leadMemory = require('./leadSystem/leadMemory');
const eventBus = require('./eventBus');
const followUpManager = require('./leadSystem/followUpManager');
const selfImprovement = require('./improvement/selfImprovement');
const messageQueue = require('./messageQueue');
const responseCache = require('./responseCache');

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
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

app.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><title>Sofia IA</title>
<style>body{font-family:Arial,sans-serif;background:#f4f4f9;color:#222;padding:24px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.08);max-width:720px;margin:0 auto}
h1{margin-top:0} .ok{color:green} .fail{color:red}</style></head><body><div class="card">
<h1>Dashboard Sofia IA</h1>
<p>Servidor online.</p>
<ul>
<li>AI: <strong class="${getSofiaResponse ? 'ok' : 'fail'}">${getSofiaResponse ? '✅ Completa' : '❌ Fallback'}</strong></li>
<li>Sanitizer: <strong class="${inputSanitizer ? 'ok' : 'fail'}">${inputSanitizer ? '✅' : '❌'}</strong></li>
<li>KB: <strong class="${knowledgeBase ? 'ok' : 'fail'}">${knowledgeBase ? '✅' : '❌'}</strong></li>
</ul></div></body></html>`);
});

app.get('/webhook', (req, res) => {
  res.status(200).json({ status: 'ok', webhook: 'active' });
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

    // Formato WASenderAPI (messages.received ou sem event)
    if (req.body.data?.messages) {
      const msg = req.body.data.messages;
      const key = msg.key || {};
      from = key.cleanedSenderPn || key.senderPn || key.remoteJid;
      texto = msg.messageBody || msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      pushName = msg.pushName || req.body.data.pushName || pushName;
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

    if (!from || !texto?.trim()) {
      console.warn(`⚠️ [${reqId}] Sem from/texto. Body: ${JSON.stringify(req.body).substring(0, 500)}`);
      return;
    }

    texto = texto.trim();

    // Limpar número E.164
    from = String(from)
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@lid$/, '')
      .replace(/^whatsapp:/, '')
      .replace(/[\s()-]/g, '')
      .trim();
    if (from && !from.startsWith('+')) from = '+' + from;

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
    selfImprovement.feedNextMessage(from, textoLimpo);
    eventBus.publish('message_received', { phone: from, nome: pushName, message: textoLimpo.substring(0, 80) });

    const startAI = Date.now();
    const result = await messageQueue.enqueue(from, async () => {
      // Verificar cache antes de chamar a IA
      const lead = await leadMemory.getLead(from).catch(() => null);
      const etapa = lead?.etapa_funil || 'novo';
      const cached = await responseCache.get(textoLimpo, etapa);
      if (cached) {
        console.log(`⚡ [${reqId}] Cache hit (${etapa}) — saltou OpenAI`);
        return { response: cached, _fromCache: true };
      }

      const r = await supervisor.processMessage(from, textoLimpo, pushName || 'Cliente');

      // Salva no cache apenas respostas factuais (não personalizadas)
      // Heurística: se a resposta não contém o nome do lead, é cacheável
      const isPersonalized = r.response && lead?.nome && r.response.includes(lead.nome);
      if (r.response && !isPersonalized) {
        await responseCache.set(textoLimpo, etapa, r.response);
      }
      return r;
    });
    const respostaIA = result.response;
    console.log(`✅ [${reqId}] supervisor em ${Date.now() - startAI}ms${result._fromCache ? ' (cache)' : ''}`);

    if (!respostaIA) {
      console.error(`❌ [${reqId}] Resposta vazia`);
      return;
    }

    console.log(`💬 [${reqId}] Resposta: "${respostaIA.substring(0, 150)}"`);

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
  console.log(`🤖 AI: ${getSofiaResponse ? 'COMPLETO (ai.js)' : 'FALLBACK (gpt-4o-mini)'}`);
  if (!OPENAI_API_KEY) console.error('🚨 OPENAI_API_KEY ausente!');
  if (!WASENDERAPI_TOKEN) console.error('🚨 WASENDERAPI_TOKEN ausente!');
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
  console.log('⏰ Iniciando cron de follow-up...');
  followUpManager.startCron(enviarMensagem);
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
