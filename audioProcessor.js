const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

        const transcription = await openai.audio.transcriptions.create({
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

    const audioPath = path.join(outputDir, `audio_${Date.now()}.ogg`);

    // Baixar áudio da URL
    await downloadFile(audioUrl, audioPath, requestOptions);

    try {
        const start = Date.now();

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: 'whisper-1',
            response_format: 'verbose_json',
            temperature: 0.2,
        });

        const latency = Date.now() - start;
        console.log(`✅ Transcrito em ${latency}ms: "${transcription.text}"`);

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

module.exports = { transcribeAudio, detectMediaType, createAudioContext, transcribeAudioFromUrl, detectMediaTypeFromMime };