/**
 * Messaging Client — Camada de abstração para envio/recebimento de mensagens
 * 
 * Substitui a Z-API. Implemente os métodos abaixo com sua nova API de WhatsApp.
 * Todos os métodos seguem a mesma interface que o resto do sistema espera.
 * 
 * Para integrar sua nova API:
 *   1. Configure as variáveis de ambiente necessárias no .env
 *   2. Implemente os métodos sendMessage(), sendTyping(), stopTyping(), getStatus()
 *   3. Pronto — o resto do sistema já funciona automaticamente
 */

const https = require('https');

class MessagingClient {
    constructor() {
        this.accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        this.authToken = process.env.TWILIO_AUTH_TOKEN || '';
        this.phoneNumber = process.env.TWILIO_PHONE_NUMBER || '';
        this.baseUrl = this.accountSid
            ? `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`
            : null;

        console.log(`📡 Messaging Client inicializado (${this.isConfigured() ? 'Twilio configurado' : 'Twilio não configurado'})`);
    }

    isConfigured() {
        return Boolean(this.accountSid && this.authToken && this.phoneNumber);
    }

    normalizePhoneNumber(phoneNumber) {
        const normalized = String(phoneNumber || '')
            .replace(/^whatsapp:/, '')
            .replace(/[\s()-]/g, '')
            .trim();

        if (!normalized) return '';
        return normalized.startsWith('+') ? normalized : `+${normalized}`;
    }

    requestTwilio(method, endpoint, formBody = null) {
        return new Promise((resolve, reject) => {
            if (!this.baseUrl) {
                reject(new Error('Twilio não configurado'));
                return;
            }

            const url = new URL(`${this.baseUrl}${endpoint}`);
            const headers = {
                Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            };

            if (formBody) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                headers['Content-Length'] = Buffer.byteLength(formBody);
            }

            const req = https.request(url, { method, headers }, (res) => {
                let responseBody = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { responseBody += chunk; });
                res.on('end', () => {
                    let parsedBody = responseBody;

                    try {
                        parsedBody = responseBody ? JSON.parse(responseBody) : {};
                    } catch (error) {
                        // Twilio retorna JSON na API usada aqui; se falhar, preservar body bruto.
                    }

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedBody);
                        return;
                    }

                    const errorMessage = typeof parsedBody === 'object'
                        ? parsedBody.message || JSON.stringify(parsedBody)
                        : responseBody;
                    reject(new Error(`Twilio HTTP ${res.statusCode}: ${errorMessage}`));
                });
            });

            req.on('error', reject);

            if (formBody) {
                req.write(formBody);
            }

            req.end();
        });
    }

    /**
     * Envia mensagem de texto para um número
     * @param {string} phoneNumber - Número no formato internacional (ex: 5511999999999)
     * @param {string} message - Texto da mensagem
     */
    async sendMessage(phoneNumber, message) {
        if (!this.isConfigured()) {
            console.warn('⚠️ Twilio não configurado. Mensagem não enviada. Defina TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_PHONE_NUMBER.');
            return { queued: false, reason: 'twilio_not_configured' };
        }

        const to = this.normalizePhoneNumber(phoneNumber);
        const from = this.normalizePhoneNumber(this.phoneNumber);
        const formBody = new URLSearchParams({
            From: `whatsapp:${from}`,
            To: `whatsapp:${to}`,
            Body: message,
        }).toString();

        const response = await this.requestTwilio('POST', '/Messages.json', formBody);
        console.log(`📤 [MessagingClient] Mensagem para ${phoneNumber}: "${message.substring(0, 80)}..."`);
        return response;
    }

    /**
     * Envia indicador de "digitando..." para um número
     * @param {string} phoneNumber
     */
    async sendTyping(phoneNumber) {
        // Twilio WhatsApp não expõe typing indicator para esta integração.
        return { supported: false, phoneNumber };
    }

    /**
     * Para o indicador de "digitando..."
     * @param {string} phoneNumber
     */
    async stopTyping(phoneNumber) {
        // No-op: Twilio WhatsApp não expõe typing indicator para esta integração.
        return { supported: false, phoneNumber };
    }

    /**
     * Verifica o status da conexão com a API
     * @returns {object} Status da conexão
     */
    async getStatus() {
        if (!this.isConfigured()) {
            return {
                connected: false,
                configured: false,
                message: 'Twilio não configurado. Defina TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_PHONE_NUMBER.'
            };
        }

        return {
            connected: true,
            configured: true,
            provider: 'twilio',
            phoneNumber: this.normalizePhoneNumber(this.phoneNumber),
        };
    }
}

module.exports = MessagingClient;
