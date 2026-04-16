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

try {
  const ai = require('./ai');
  getSofiaResponse = ai.getSofiaResponse;
  console.log('📌 [BOOT] ai.js OK (Sofia completa)');
} catch (e) {
  console.warn('⚠️ [BOOT] ai.js falhou:', e.message);
}

try { inputSanitizer = require('./inputSanitizer'); console.log('📌 [BOOT] inputSanitizer OK'); } catch (e) { console.warn('⚠️ [BOOT] inputSanitizer falhou:', e.message); }
try { topicBlacklist = require('./topicBlacklist'); console.log('📌 [BOOT] topicBlacklist OK'); } catch (e) { console.warn('⚠️ [BOOT] topicBlacklist falhou:', e.message); }
try { conversationManager = require('./conversationManager'); console.log('📌 [BOOT] conversationManager OK'); } catch (e) { console.warn('⚠️ [BOOT] conversationManager falhou:', e.message); }
try { clientMemory = require('./clientMemory'); console.log('📌 [BOOT] clientMemory OK'); } catch (e) { console.warn('⚠️ [BOOT] clientMemory falhou:', e.message); }
try { kpiTracker = require('./kpiTracker'); console.log('📌 [BOOT] kpiTracker OK'); } catch (e) { console.warn('⚠️ [BOOT] kpiTracker falhou:', e.message); }
try { auditLogger = require('./auditLogger'); console.log('📌 [BOOT] auditLogger OK'); } catch (e) { console.warn('⚠️ [BOOT] auditLogger falhou:', e.message); }
try { knowledgeBase = require('./knowledgeBase'); console.log('📌 [BOOT] knowledgeBase OK'); } catch (e) { console.warn('⚠️ [BOOT] knowledgeBase falhou:', e.message); }
try { intentFlow = require('./intentFlow'); console.log('📌 [BOOT] intentFlow OK'); } catch (e) { console.warn('⚠️ [BOOT] intentFlow falhou:', e.message); }

console.log('📌 [BOOT] Imports concluídos');

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

// ── Rate limiter ──
const rateLimits = {};
function checkRateLimit(phone) {
  const now = Date.now();
  if (!rateLimits[phone]) rateLimits[phone] = [];
  rateLimits[phone] = rateLimits[phone].filter(t => now - t < 60000);
  if (rateLimits[phone].length >= 10) return false;
  rateLimits[phone].push(now);
  return true;
}

// ── Rotas ──
app.get('/', (req, res) => res.send('✅ SOFIA IA - Quality Hair está ONLINE!'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    modules: {
      ai: !!getSofiaResponse,
      inputSanitizer: !!inputSanitizer,
      topicBlacklist: !!topicBlacklist,
      conversationManager: !!conversationManager,
      clientMemory: !!clientMemory,
      knowledgeBase: !!knowledgeBase,
    }
  });
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
<li>AI: <strong class="${getSofiaResponse ? 'ok' : 'fail'}">${getSofiaResponse ? '✅ Completa' : '❌ Fallback'}</strong></li>
<li>Sanitizer: <strong class="${inputSanitizer ? 'ok' : 'fail'}">${inputSanitizer ? '✅' : '❌'}</strong></li>
<li>KB: <strong class="${knowledgeBase ? 'ok' : 'fail'}">${knowledgeBase ? '✅' : '❌'}</strong></li>
</ul></div></body></html>`);
});

app.get('/webhook', (req, res) => {
  res.status(200).json({ status: 'ok', webhook: 'active' });
});

// ── POST /webhook — Processamento principal ──
app.post('/webhook', async (req, res) => {
  const reqId = Date.now().toString(36);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📨 [${reqId}] WEBHOOK - ${new Date().toISOString()}`);

  // STEP 1: Auth
  if (!authenticateWebhookRequest(req)) {
    console.error(`🚫 [${reqId}] Auth FALHOU`);
    return res.status(403).json({ status: 'unauthorized' });
  }

  // Responder 200 imediatamente
  res.status(200).json({ status: 'received' });

  try {
    // STEP 2: Evento
    const event = req.body.event;
    if (event && event !== 'messages.received') {
      console.log(`⏭️ [${reqId}] Evento "${event}" ignorado`);
      return;
    }

    // STEP 3: Extrair remetente e texto
    let from = null;
    let texto = null;

    // Formato WASenderAPI (messages.received)
    if (req.body.data?.messages) {
      const msg = req.body.data.messages;
      const key = msg.key || {};
      from = key.cleanedSenderPn || key.senderPn || key.remoteJid;
      texto = msg.messageBody || msg.message?.conversation || msg.message?.extendedTextMessage?.text;
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
    }

    // Formato flat
    if (!from && (req.body.from || req.body.sender || req.body.phone)) {
      from = req.body.from || req.body.sender || req.body.phone;
      texto = req.body.message || req.body.body || req.body.text;
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
        const sanitized = inputSanitizer.sanitize(texto);
        if (sanitized.blocked) {
          console.warn(`🛡️ [${reqId}] Input bloqueado: ${sanitized.reason}`);
          await enviarMensagem(from, 'Desculpe, não entendi. Pode reformular?');
          return;
        }
        textoLimpo = sanitized.text || texto;
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

    // STEP 4: Gerar resposta
    console.log(`🧠 [${reqId}] Gerando resposta...`);
    const startAI = Date.now();
    let respostaIA;

    if (getSofiaResponse) {
      try {
        respostaIA = await getSofiaResponse(from, textoLimpo);
        console.log(`✅ [${reqId}] ai.js em ${Date.now() - startAI}ms`);
      } catch (aiErr) {
        console.error(`❌ [${reqId}] ai.js erro: ${aiErr.message}`);
        respostaIA = await fallbackResponse(textoLimpo);
        console.log(`⚠️ [${reqId}] Fallback usado`);
      }
    } else {
      respostaIA = await fallbackResponse(textoLimpo);
      console.log(`⚠️ [${reqId}] Fallback (ai.js indisponível)`);
    }

    if (!respostaIA) {
      console.error(`❌ [${reqId}] Resposta vazia`);
      return;
    }

    console.log(`💬 [${reqId}] Resposta: "${respostaIA.substring(0, 150)}"`);

    // Tracking
    if (kpiTracker) { try { kpiTracker.recordResponse(Date.now() - startAI); } catch (e) {} }
    if (auditLogger) { try { auditLogger.logMessage(from, textoLimpo, respostaIA); } catch (e) {} }
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

// ── Knowledge Base em background (não bloqueia boot) ──
if (knowledgeBase && typeof knowledgeBase.initialize === 'function') {
  setTimeout(() => {
    console.log('📚 Inicializando Knowledge Base (background)...');
    knowledgeBase.initialize()
      .then(() => console.log('✅ Knowledge Base pronta'))
      .catch(e => console.warn('⚠️ KB falhou:', e.message));
  }, 3000);
}

// ── Start ──
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
  process.exit(1);
});
