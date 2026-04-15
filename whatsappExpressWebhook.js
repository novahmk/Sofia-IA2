const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

const ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WEBHOOK_SECRET = process.env.WASENDERAPI_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WASENDERAPI_BASE_URL = process.env.WASENDERAPI_BASE_URL || 'https://www.wasenderapi.com/api';
const WASENDERAPI_TOKEN = process.env.WASENDERAPI_TOKEN || ACCESS_TOKEN;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

function computeSignature(rawBody, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(rawBody || '')
    .digest('hex');
}

function authenticateWebhookRequest(req) {
  if (WEBHOOK_API_KEY) {
    const apiKeyHeader = req.header('x-api-key');
    if (!safeCompare(apiKeyHeader || '', WEBHOOK_API_KEY)) {
      console.warn('⁉️ Cabeçalho x-api-key inválido ou ausente');
      return false;
    }
  }

  if (WEBHOOK_SECRET) {
    const secretHeader = req.header('x-webhook-secret');
    const signatureHeader = req.header('x-webhook-signature');
    const body = req.rawBody || '';

    if (secretHeader && safeCompare(secretHeader, WEBHOOK_SECRET)) {
      return true;
    }

    if (signatureHeader) {
      const received = signatureHeader.toLowerCase().startsWith('sha256=')
        ? signatureHeader.slice('sha256='.length)
        : signatureHeader;
      const expected = computeSignature(body, WEBHOOK_SECRET);
      if (safeCompare(received, expected)) {
        return true;
      }
    }

    console.warn('⁉️ Falha na validação do webhook: x-webhook-secret / x-webhook-signature inválido');
    return false;
  }

  return true;
}

function createOpenAIResponse(userText) {
  return openai.chat.completions.create({
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
  if (!WASENDERAPI_BASE_URL || !WASENDERAPI_TOKEN) {
    throw new Error('WASENDERAPI_BASE_URL ou WASENDERAPI_TOKEN não configurado');
  }

  const sendUrl = `${WASENDERAPI_BASE_URL.replace(/\/$/, '')}/send-message`;

  const payload = { to, text };

  console.log(`📤 Enviando para WASenderAPI: ${sendUrl} | to=${to}`);

  const response = await axios.post(sendUrl, payload, {
    headers: {
      Authorization: `Bearer ${WASENDERAPI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  console.log(`✅ WASenderAPI respondeu:`, JSON.stringify(response.data));
  return response.data;
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
  console.log('\n📨 NOVA MENSAGEM RECEBIDA -', new Date().toISOString());
  console.log('📦 Payload recebido:', JSON.stringify(req.body).substring(0, 800));

  if (!authenticateWebhookRequest(req)) {
    return res.status(403).json({ status: 'unauthorized' });
  }

  // Responder 200 imediatamente para o provedor não dar timeout
  res.status(200).json({ status: 'received' });

  try {
    // Ignorar eventos que não são mensagens recebidas
    const event = req.body.event;
    if (event && event !== 'messages.received') {
      console.log(`ℹ️ Evento ignorado: ${event}`);
      return;
    }

    // ===== EXTRAIR MENSAGEM (suporta múltiplos formatos) =====
    let from = null;
    let texto = null;

    // Formato WASenderAPI real:
    // { event: "messages.received", data: { messages: { key: { remoteJid, cleanedSenderPn }, messageBody, message: { conversation } } } }
    if (req.body.data?.messages) {
      const msg = req.body.data.messages;
      const key = msg.key || {};

      // Extrair número do remetente (preferir cleanedSenderPn, senão remoteJid)
      from = key.cleanedSenderPn
        || key.senderPn
        || key.remoteJid;

      // Extrair texto da mensagem
      texto = msg.messageBody
        || msg.message?.conversation
        || msg.message?.extendedTextMessage?.text;

      // Ignorar mensagens enviadas por nós mesmos
      if (key.fromMe === true) {
        console.log('🔄 Mensagem própria (fromMe), ignorando');
        return;
      }
    }

    // Formato WASenderAPI alternativo simples: { data: { from, message } }
    if (!from && req.body.data) {
      const data = req.body.data;
      from = data.from || data.sender || data.phone || data.number;
      texto = data.message || data.body || data.text || data.messageBody;
    }

    // Formato flat: { from, message }
    if (!from && (req.body.from || req.body.sender || req.body.phone)) {
      from = req.body.from || req.body.sender || req.body.phone;
      texto = req.body.message || req.body.body || req.body.text;
    }

    // Formato Meta/Cloud API: { entry[0].changes[0].value.messages[0] }
    if (!from && req.body.entry) {
      const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (msg) {
        from = msg.from;
        texto = msg.text?.body;
      }
    }

    if (!from || !texto) {
      console.log('⚠️ Payload sem mensagem válida (from ou texto ausente)');
      return;
    }

    texto = texto.trim();
    if (!texto) {
      console.log('⚠️ Mensagem vazia, ignorando');
      return;
    }

    // Limpar número (remover @s.whatsapp.net, @lid, whatsapp:, +, espaços)
    from = String(from)
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@lid$/, '')
      .replace(/^whatsapp:/, '')
      .replace(/[\s+()-]/g, '')
      .trim();

    console.log(`💬 Mensagem de ${from}: "${texto}"`);

    const completion = await createOpenAIResponse(texto);
    const respostaIA = completion.choices?.[0]?.message?.content?.trim();

    if (!respostaIA) {
      throw new Error('Resposta da OpenAI vazia');
    }

    console.log(`🤖 Sofia respondeu: "${respostaIA}"`);
    await enviarMensagem(from, respostaIA);

  } catch (error) {
    console.error('❌ ERRO ao processar:', error.response?.data || error.message || error);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Sofia IA rodando na porta ${PORT}`);
  console.log(`🔗 Webhook: POST /webhook`);
  console.log(`📊 Dashboard: GET /dashboard`);
  console.log(`🏥 Health: GET /health`);
  console.log(`📡 WASenderAPI URL: ${WASENDERAPI_BASE_URL}`);
  console.log(`🔑 Token configurado: ${WASENDERAPI_TOKEN ? 'SIM' : 'NÃO'}`);
  console.log(`🔐 Webhook Secret configurado: ${WEBHOOK_SECRET ? 'SIM' : 'NÃO'}`);
  console.log(`✅ Verify Token configurado: ${VERIFY_TOKEN ? 'SIM' : 'NÃO'}`);
});
