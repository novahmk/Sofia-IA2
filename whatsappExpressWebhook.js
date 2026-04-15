const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

const ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_SECRET = process.env.WASENDERAPI_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WASENDERAPI_BASE_URL = process.env.WASENDERAPI_BASE_URL || 'https://www.wasenderapi.com/api';
const WASENDERAPI_TOKEN = process.env.WASENDERAPI_TOKEN || ACCESS_TOKEN;

// Inicialização lazy do OpenAI — NÃO crasha no startup se a chave estiver ausente
let openai = null;
function getOpenAI() {
  if (!openai) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurada. Defina a variável de ambiente.');
    }
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return openai;
}

function rawBodySaver(req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}

app.use(express.json({ verify: rawBodySaver, limit: '1mb' }));
app.use(express.urlencoded({ extended: true, verify: rawBodySaver, limit: '1mb' }));

function safeCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function authenticateWebhookRequest(req) {
  // WASenderAPI envia o WASENDERAPI_WEBHOOK_SECRET no header X-Webhook-Signature
  if (!WEBHOOK_SECRET) {
    // Se não configurou secret, aceita tudo (dev/teste)
    return true;
  }

  const signature = req.header('x-webhook-signature') || '';
  if (safeCompare(signature, WEBHOOK_SECRET)) {
    return true;
  }

  console.warn(`⁉️ Webhook rejeitado: X-Webhook-Signature inválido ou ausente`);
  return false;
}

function createOpenAIResponse(userText) {
  return getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é Sofia, uma assistente útil, educada e amigável. Responda sempre em português brasileiro de forma natural.',
      },
      { role: 'user', content: userText },
    ],
    max_tokens: 500,
    temperature: 0.7,
  });
}

async function enviarMensagem(to, text) {
  if (!WASENDERAPI_TOKEN) {
    throw new Error('WASENDERAPI_TOKEN não configurado! Defina no Railway com o API Key da sessão WhatsApp.');
  }

  const sendUrl = `${WASENDERAPI_BASE_URL.replace(/\/$/, '')}/send-message`;
  const payload = { to, text };

  console.log(`📤 WASenderAPI request:`);
  console.log(`  URL: ${sendUrl}`);
  console.log(`  Auth: Bearer ${WASENDERAPI_TOKEN.substring(0, 12)}...`);
  console.log(`  Payload: ${JSON.stringify(payload).substring(0, 300)}`);

  try {
    const response = await axios.post(sendUrl, payload, {
      headers: {
        Authorization: `Bearer ${WASENDERAPI_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    console.log(`✅ WASenderAPI response: HTTP ${response.status}`);
    console.log(`  Data: ${JSON.stringify(response.data).substring(0, 500)}`);
    return response.data;
  } catch (axiosError) {
    console.error(`❌ WASenderAPI FALHOU:`);
    console.error(`  Status: ${axiosError.response?.status || 'sem response'}`);
    console.error(`  Body: ${JSON.stringify(axiosError.response?.data || axiosError.message)}`);
    throw axiosError;
  }
}

app.get('/', (req, res) => {
  res.send('✅ SOFIA IA - Bot Quality + OpenAI está ONLINE!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/dashboard', (req, res) => {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Sofia IA Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f9; color: #222; padding: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,.08); max-width: 720px; margin: 0 auto; }
    h1 { margin-top: 0; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Dashboard Sofia IA</h1>
    <p>Servidor online e pronto para receber webhooks.</p>
    <ul>
      <li>Status: <strong>Online</strong></li>
      <li>Webhook: <strong>/webhook</strong></li>
      <li>Health: <strong>/health</strong></li>
    </ul>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/webhook', (req, res) => {
  console.log('🔍 Verificação GET recebida:', req.query);
  // WASenderAPI faz um GET simples para verificar se o endpoint existe
  // Retorna 200 para qualquer GET, opcionalmente ecoando hub.challenge se presente
  console.log('✅ Webhook verificado com sucesso!');
  return res.status(200).json({ status: 'ok', webhook: 'active' });
});

app.get('/webhook/whatsapp', (req, res) => res.redirect(301, '/webhook'));

app.post('/webhook', async (req, res) => {
  const reqId = Date.now().toString(36);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📨 [${reqId}] WEBHOOK RECEBIDO - ${new Date().toISOString()}`);
  console.log(`📨 [${reqId}] Headers:`, JSON.stringify({
    'content-type': req.header('content-type'),
    'x-webhook-signature': req.header('x-webhook-signature') ? '***SET***' : 'AUSENTE',
    'user-agent': req.header('user-agent'),
  }));
  console.log(`📨 [${reqId}] Body (800 chars):`, JSON.stringify(req.body).substring(0, 800));

  // ── STEP 1: Autenticação ──
  console.log(`\n🔐 [${reqId}] STEP 1: Verificando autenticação...`);
  if (!authenticateWebhookRequest(req)) {
    console.error(`🚫 [${reqId}] STEP 1 FALHOU: X-Webhook-Signature inválido`);
    return res.status(403).json({ status: 'unauthorized' });
  }
  console.log(`✅ [${reqId}] STEP 1: Autenticação OK`);

  // Responder 200 imediatamente para o provedor não dar timeout
  res.status(200).json({ status: 'received' });
  console.log(`📤 [${reqId}] Response 200 enviado ao WASenderAPI`);

  try {
    // ── STEP 2: Verificar tipo de evento ──
    const event = req.body.event;
    console.log(`\n📋 [${reqId}] STEP 2: Evento recebido: "${event || 'NENHUM'}"`);
    if (event && event !== 'messages.received') {
      console.log(`⏭️ [${reqId}] STEP 2: Evento "${event}" ignorado (não é messages.received)`);
      return;
    }
    console.log(`✅ [${reqId}] STEP 2: Evento válido`);

    // ── STEP 3: Extrair remetente e texto ──
    console.log(`\n🔍 [${reqId}] STEP 3: Extraindo remetente e texto...`);
    let from = null;
    let texto = null;

    // Formato WASenderAPI real (messages.received)
    if (req.body.data?.messages) {
      const msg = req.body.data.messages;
      const key = msg.key || {};

      console.log(`  [${reqId}] Formato: WASenderAPI messages.received`);
      console.log(`  [${reqId}] key.fromMe: ${key.fromMe}`);
      console.log(`  [${reqId}] key.cleanedSenderPn: ${key.cleanedSenderPn}`);
      console.log(`  [${reqId}] key.senderPn: ${key.senderPn}`);
      console.log(`  [${reqId}] key.remoteJid: ${key.remoteJid}`);
      console.log(`  [${reqId}] msg.messageBody: ${msg.messageBody ? '"' + msg.messageBody.substring(0, 100) + '"' : 'AUSENTE'}`);
      console.log(`  [${reqId}] msg.message?.conversation: ${msg.message?.conversation ? '"' + msg.message.conversation.substring(0, 100) + '"' : 'AUSENTE'}`);

      from = key.cleanedSenderPn || key.senderPn || key.remoteJid;
      texto = msg.messageBody || msg.message?.conversation || msg.message?.extendedTextMessage?.text;

      if (key.fromMe === true) {
        console.log(`🔄 [${reqId}] STEP 3: Mensagem própria (fromMe=true), ignorando`);
        return;
      }
    }

    // Formato alternativo: { data: { from, message } }
    if (!from && req.body.data) {
      const data = req.body.data;
      from = data.from || data.sender || data.phone || data.number;
      texto = data.message || data.body || data.text || data.messageBody;
      if (from) console.log(`  [${reqId}] Formato: data.from/message alternativo`);
    }

    // Formato flat: { from, message }
    if (!from && (req.body.from || req.body.sender || req.body.phone)) {
      from = req.body.from || req.body.sender || req.body.phone;
      texto = req.body.message || req.body.body || req.body.text;
      if (from) console.log(`  [${reqId}] Formato: flat (from/message no root)`);
    }

    // Formato Meta/Cloud API
    if (!from && req.body.entry) {
      const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (msg) {
        from = msg.from;
        texto = msg.text?.body;
        console.log(`  [${reqId}] Formato: Meta/Cloud API`);
      }
    }

    console.log(`  [${reqId}] from (raw): ${JSON.stringify(from)}`);
    console.log(`  [${reqId}] texto (raw): ${JSON.stringify(texto ? texto.substring(0, 200) : null)}`);

    if (!from || !texto) {
      console.warn(`⚠️ [${reqId}] STEP 3 FALHOU: from=${!!from}, texto=${!!texto} — payload sem mensagem válida`);
      console.warn(`  [${reqId}] Body completo:`, JSON.stringify(req.body).substring(0, 2000));
      return;
    }

    texto = texto.trim();
    if (!texto) {
      console.warn(`⚠️ [${reqId}] STEP 3 FALHOU: Mensagem vazia após trim`);
      return;
    }

    // Limpar número para formato E.164
    from = String(from)
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@lid$/, '')
      .replace(/^whatsapp:/, '')
      .replace(/[\s()-]/g, '')
      .trim();

    if (from && !from.startsWith('+')) {
      from = '+' + from;
    }

    console.log(`✅ [${reqId}] STEP 3: from="${from}", texto="${texto.substring(0, 80)}"`);

    // ── STEP 4: Chamar OpenAI ──
    console.log(`\n🧠 [${reqId}] STEP 4: Chamando OpenAI (gpt-4o-mini)...`);
    const startAI = Date.now();
    const completion = await createOpenAIResponse(texto);
    const aiTime = Date.now() - startAI;
    const respostaIA = completion.choices?.[0]?.message?.content?.trim();

    if (!respostaIA) {
      console.error(`❌ [${reqId}] STEP 4 FALHOU: Resposta da OpenAI vazia`);
      console.error(`  [${reqId}] choices:`, JSON.stringify(completion.choices));
      return;
    }

    console.log(`✅ [${reqId}] STEP 4: OpenAI respondeu em ${aiTime}ms`);
    console.log(`  [${reqId}] Resposta: "${respostaIA.substring(0, 200)}"`);

    // ── STEP 5: Enviar resposta via WASenderAPI ──
    console.log(`\n📤 [${reqId}] STEP 5: Enviando resposta via WASenderAPI...`);
    console.log(`  [${reqId}] URL: ${WASENDERAPI_BASE_URL}/send-message`);
    console.log(`  [${reqId}] Token: ${WASENDERAPI_TOKEN ? WASENDERAPI_TOKEN.substring(0, 12) + '...' : 'NÃO CONFIGURADO!'}`);
    console.log(`  [${reqId}] Payload: { to: "${from}", text: "${respostaIA.substring(0, 80)}..." }`);

    const startSend = Date.now();
    await enviarMensagem(from, respostaIA);
    const sendTime = Date.now() - startSend;

    console.log(`✅ [${reqId}] STEP 5: Mensagem enviada em ${sendTime}ms`);
    console.log(`🎉 [${reqId}] FLUXO COMPLETO: ${from} → OpenAI (${aiTime}ms) → WASenderAPI (${sendTime}ms)`);
    console.log(`${'='.repeat(60)}\n`);

  } catch (error) {
    console.error(`\n❌ [${reqId}] ERRO NO FLUXO:`);
    console.error(`  [${reqId}] Tipo: ${error.constructor?.name || 'Unknown'}`);
    console.error(`  [${reqId}] Mensagem: ${error.message}`);
    if (error.response) {
      console.error(`  [${reqId}] HTTP Status: ${error.response.status}`);
      console.error(`  [${reqId}] Response Body: ${JSON.stringify(error.response.data)}`);
      console.error(`  [${reqId}] Response Headers: ${JSON.stringify(error.response.headers)}`);
    }
    if (error.code) {
      console.error(`  [${reqId}] Error Code: ${error.code}`);
    }
    console.error(`  [${reqId}] Stack:`, error.stack?.split('\n').slice(0, 5).join('\n'));
    console.error(`${'='.repeat(60)}\n`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sofia IA rodando na porta ${PORT} (0.0.0.0)`);
  console.log(`🔗 Webhook: POST /webhook`);
  console.log(`📊 Dashboard: GET /dashboard`);
  console.log(`🏥 Health: GET /health`);
  console.log(`📡 WASenderAPI URL: ${WASENDERAPI_BASE_URL}`);
  console.log(`🔑 WASenderAPI Token: ${WASENDERAPI_TOKEN ? 'SIM (' + WASENDERAPI_TOKEN.substring(0, 8) + '...)' : '⚠️ NÃO CONFIGURADO'}`);
  console.log(`🔐 Webhook Secret: ${WEBHOOK_SECRET ? 'SIM' : '⚠️ NÃO (aceitando tudo)'}`);
  console.log(`🧠 OpenAI API Key: ${OPENAI_API_KEY ? 'SIM (' + OPENAI_API_KEY.substring(0, 8) + '...)' : '⚠️ NÃO CONFIGURADO'}`);
  
  // Validações de startup
  if (!OPENAI_API_KEY) console.error('🚨 OPENAI_API_KEY ausente — bot não conseguirá gerar respostas!');
  if (!WASENDERAPI_TOKEN) console.error('🚨 WASENDERAPI_TOKEN ausente — bot não conseguirá enviar mensagens!');
  if (!WEBHOOK_SECRET) console.warn('⚠️ WASENDERAPI_WEBHOOK_SECRET ausente — webhook aceita requisições de qualquer origem');
});
