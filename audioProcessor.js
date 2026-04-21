const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { OpenAI } = require('openai');

let _openai = null;
function getOpenAI() {
    if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openai;
}

/**
 * Descriptografa mídia do WhatsApp usando AES-256-CBC + HKDF-SHA256.
 * O WhatsApp criptografa todas as mídias antes de enviar ao CDN.
 * @param {Buffer} encryptedData - arquivo baixado do CDN
 * @param {string} mediaKeyB64 - mediaKey em base64 do payload do webhook
 * @param {string} mediaType - 'Audio' | 'Video' | 'Image' | 'Document'
 */
function decryptWhatsAppMedia(encryptedData, mediaKeyB64, mediaType = 'Audio') {
    const mediaKey = Buffer.from(mediaKeyB64, 'base64');
    const info = Buffer.from(`WhatsApp ${mediaType} Keys`);

    // HKDF-SHA256: extrai 112 bytes
    const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(mediaKey).digest();
    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    for (let i = 1; okm.length < 112; i++) {
        const hmac = crypto.createHmac('sha256', prk);
        hmac.update(t);
        hmac.update(info);
        hmac.update(Buffer.from([i]));
        t = hmac.digest();
        okm = Buffer.concat([okm, t]);
    }
    okm = okm.slice(0, 112);

    const iv = okm.slice(0, 16);
    const cipherKey = okm.slice(16, 48);

    // Remove 10 bytes de MAC do final
    const ciphertext = encryptedData.slice(0, encryptedData.length - 10);

    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function transcribeAudio(message, preDownloadedMedia = null, outputDir = './temp_audio') {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`🎙️ Processando áudio de ${message.from}...`);

    // Reutilizar mídia já baixada ou baixar se não fornecida
    const media = preDownloadedMedia || await message.downloadMedia();
    if (!media) throw new Error('Falha ao baixar arquivo de áudio');

    const audioPath = path.join(outputDir, `audio_${Date.now()}.ogg`);
    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(audioPath, buffer);

    try {
        const start = Date.now();

        const transcription = await getOpenAI().audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: 'whisper-1',
            response_format: 'verbose_json', // retorna idioma detectado
            temperature: 0.2,
        });

        const latency = Date.now() - start;
        console.log(`✅ Transcrito em ${latency}ms: "${transcription.text}"`);

        return {
            text: transcription.text,
            language: transcription.language || 'unknown',
            confidence: 'high',
            transcriptionLatency: latency,
            media, // retornar para evitar segundo download
        };

    } finally {
        // Sempre limpa o arquivo, mesmo em caso de erro
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
}

function detectMediaType(message, media = null) {
    try {
        if (!message.hasMedia) return 'text';
        const m = media;
        if (!m) return 'unknown';
        const mimeType = m?.mimetype || '';

        if (mimeType.includes('audio'))    return 'audio';
        if (mimeType.includes('video'))    return 'video';
        if (mimeType.includes('image'))    return 'image';
        if (mimeType.includes('pdf') || 
            mimeType.includes('document')) return 'document';

        return 'unknown';
    } catch (err) {
        console.error(`Erro ao detectar mídia: ${err.message}`);
        return 'unknown';
    }
}

function createAudioContext(transcriptionData) {
    return `
[ANÁLISE DE ÁUDIO DO CLIENTE]
- Texto transcrito: "${transcriptionData.text}"
- Idioma detectado: ${transcriptionData.language}
- Qualidade da transcrição: ${transcriptionData.confidence}
- Tempo de processamento: ${transcriptionData.transcriptionLatency}ms

Importante: Este texto foi obtido de um áudio. Responda de forma 
humanizada, empática e acolhedora.
    `.trim();
}

function downloadFile(sourceUrl, destinationPath, requestOptions = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Falha ao baixar áudio: redirects em excesso'));
            return;
        }

        const client = sourceUrl.startsWith('https') ? https : http;
        const request = client.get(sourceUrl, requestOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                downloadFile(res.headers.location, destinationPath, requestOptions, redirectCount + 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Falha ao baixar áudio: HTTP ${res.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(destinationPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(resolve);
            });
            fileStream.on('error', (error) => {
                fs.unlink(destinationPath, () => reject(error));
            });
        });

        request.on('error', reject);
    });
}

/**
 * Baixa áudio de uma URL (Z-API) e transcreve via Whisper.
 */
async function transcribeAudioFromUrl(audioUrl, phoneNumber, outputDir = './temp_audio', requestOptions = {}) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`🎙️ Processando áudio de ${phoneNumber} via URL...`);

    // WhatsApp envia áudio como OGG/Opus — Whisper aceita .ogg com nome explícito
    const audioPath = path.join(outputDir, `audio_${Date.now()}.ogg`);

    // Baixar áudio da URL
    await downloadFile(audioUrl, audioPath, requestOptions);

    try {
        const start = Date.now();

        // Passa o nome do arquivo explicitamente para o Whisper reconhecer o formato OGG
        const { toFile } = require('openai');
        const fileStream = fs.createReadStream(audioPath);
        const file = await toFile(fileStream, 'audio.ogg', { type: 'audio/ogg' });

        const transcription = await getOpenAI().audio.transcriptions.create({
            file,
            model: 'whisper-1',
            response_format: 'verbose_json',
            temperature: 0.2,
        });

        const latency = Date.now() - start;
        console.log(`✅ Transcrito em ${latency}ms (${transcription.language}): "${transcription.text}"`);

        return {
            text: transcription.text,
            language: transcription.language || 'unknown',
            confidence: 'high',
            transcriptionLatency: latency,
        };
    } finally {
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
}

/**
 * Transcreve áudio do WhatsApp via WASenderAPI (descriptografa na API) + Whisper.
 * Tenta 3 endpoints comuns do WASenderAPI antes de cair no download direto.
 */
async function transcribeAudioViaWASender({ audioMessage, phoneNumber, sessionId, outputDir = '/tmp/sofia_audio', waToken, waBaseUrl }) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const audioPath = path.join(outputDir, `audio_${Date.now()}.ogg`);
    const baseUrl = (waBaseUrl || 'https://www.wasenderapi.com/api').replace(/\/$/, '');
    const mediaKey = audioMessage.mediaKey || audioMessage.MediaKey || null;
    const encUrl = audioMessage.url || null;

    if (!encUrl || !mediaKey) {
        throw new Error(`Áudio sem url ou mediaKey no payload (url=${!!encUrl}, mediaKey=${!!mediaKey})`);
    }

    // Passo 1: chamar o Decrypt Media File API da WASenderAPI
    // Retorna { publicUrl } válida por 1 hora com o OGG já descriptografado
    console.log(`🔓 [Audio] Solicitando descriptografia via WASenderAPI /decrypt-media...`);
    const isPtt = audioMessage._type === 'ptt';
    const messagePayload = isPtt
        ? { pttMessage: audioMessage }
        : { audioMessage: audioMessage };

    const decryptResp = await fetch(`${baseUrl}/decrypt-media`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: {
                messages: {
                    message: messagePayload
                }
            }
        }),
        signal: AbortSignal.timeout(20000),
    });

    console.log(`🔓 Status decrypt-media: ${decryptResp.status}`);
    const decryptRaw = await decryptResp.text();
    console.log(`🔓 Resposta decrypt-media: ${decryptRaw.substring(0, 500)}`);

    if (!decryptResp.ok) {
        throw new Error(`WASenderAPI /decrypt-media HTTP ${decryptResp.status}: ${decryptRaw.substring(0, 200)}`);
    }

    const decryptData = JSON.parse(decryptRaw);
    const publicUrl = decryptData?.publicUrl || decryptData?.data?.publicUrl || decryptData?.url;

    if (!publicUrl) {
        throw new Error(`/decrypt-media não retornou publicUrl. Resposta: ${JSON.stringify(decryptData).substring(0, 200)}`);
    }

    // Passo 2: baixar o OGG descriptografado da publicUrl
    console.log(`📥 [Audio] Baixando OGG descriptografado...`);
    await downloadFile(publicUrl, audioPath, {});

    try {
        const start = Date.now();
        const { toFile } = require('openai');
        const file = await toFile(fs.createReadStream(audioPath), 'audio.ogg', { type: 'audio/ogg' });

        const transcription = await getOpenAI().audio.transcriptions.create({
            file,
            model: 'whisper-1',
            response_format: 'verbose_json',
            temperature: 0.2,
        });

        const latency = Date.now() - start;
        console.log(`✅ Transcrito em ${latency}ms (${transcription.language}): "${transcription.text}"`);

        return {
            text: transcription.text,
            language: transcription.language || 'unknown',
            confidence: 'high',
            transcriptionLatency: latency,
        };
    } finally {
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
}

/**
 * Detecta tipo de mídia a partir de um mimeType string (Z-API webhook).
 */
function detectMediaTypeFromMime(mimeType) {
    if (!mimeType) return 'unknown';
    if (mimeType.includes('audio'))    return 'audio';
    if (mimeType.includes('video'))    return 'video';
    if (mimeType.includes('image'))    return 'image';
    if (mimeType.includes('pdf') || 
        mimeType.includes('document')) return 'document';
    return 'unknown';
}

module.exports = { transcribeAudio, detectMediaType, createAudioContext, transcribeAudioFromUrl, transcribeAudioViaWASender, detectMediaTypeFromMime };