/**
 * Messaging Client — Camada de abstração para envio/recebimento de mensagens.
 * Runtime atual usa somente WASenderAPI.
 */

const https = require('https');

class MessagingClient {
    constructor() {
        this.provider = 'wasenderapi';
        this.token = process.env.WASENDERAPI_TOKEN || '';
        this.baseUrl = (process.env.WASENDERAPI_BASE_URL || '').replace(/\/$/, '');
        this.sendPath = '/api/send-message';

        this._parsedUrl = null;
        try {
            this._parsedUrl = new URL(this.baseUrl);
        } catch (e) {
            console.error(`❌ ${this.provider.toUpperCase()} BASE_URL inválida:`, this.baseUrl);
        }

        console.log(`📡 Messaging Client inicializado (${this.provider.toUpperCase()} configurado — ${this.baseUrl})`);
    }

    isConfigured() {
        return Boolean(this.token && this._parsedUrl);
    }

    /**
     * Normaliza número de telefone para envio (apenas dígitos)
     */
    normalizePhoneNumber(phoneNumber) {
        return String(phoneNumber || '')
            .replace(/^whatsapp:/, '')
            .replace(/@s\.whatsapp\.net$/, '')
            .replace(/[^0-9]/g, '')
            .trim();
    }

    _getHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Faz request HTTPS genérica para o provider configurado
     */
    _request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            if (!this.isConfigured()) {
                reject(new Error(`${this.provider.toUpperCase()} não configurado. Defina ${this.provider.toUpperCase()}_TOKEN e ${this.provider.toUpperCase()}_BASE_URL.`));
                return;
            }

            const url = new URL(path, this.baseUrl);
            const headers = this._getHeaders();

            let postData = null;
            if (body) {
                postData = JSON.stringify(body);
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(postData);
            }

            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers,
            };

            const protocol = url.protocol === 'https:' ? https : require('http');
            const req = protocol.request(options, (res) => {
                let responseBody = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { responseBody += chunk; });
                res.on('end', () => {
                    let parsed = responseBody;
                    try { parsed = responseBody ? JSON.parse(responseBody) : {}; } catch (e) {}

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        const msg = typeof parsed === 'object'
                            ? parsed.error || parsed.message || JSON.stringify(parsed)
                            : responseBody;
                        reject(new Error(`${this.provider.toUpperCase()} HTTP ${res.statusCode}: ${msg}`));
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error(`${this.provider.toUpperCase()} timeout (15s)`)); });

            if (postData) req.write(postData);
            req.end();
        });
    }

    /**
     * Envia mensagem de texto via WASenderAPI
     */
    async sendMessage(phoneNumber, message) {
        if (!this.isConfigured()) {
            console.warn(`⚠️ ${this.provider.toUpperCase()} não configurado. Mensagem não enviada.`);
            return { queued: false, reason: `${this.provider}_not_configured` };
        }

        const phone = this.normalizePhoneNumber(phoneNumber);
        const payload = {
            to: phone,
            text: message,
        };

        const response = await this._request('POST', this.sendPath, payload);
        console.log(`📤 [${this.provider.toUpperCase()}] Mensagem para ${phone}: "${message.substring(0, 80)}..."`);
        return response;
    }

    /**
     * Simula "digitando..." — não implementado no runtime atual
     */
    async sendTyping(phoneNumber) {
        return { supported: false, phoneNumber };
    }

    /**
     * Para de "digitar" — não implementado no runtime atual
     */
    async stopTyping(phoneNumber) {
        return { supported: false, phoneNumber };
    }

    /**
     * Verifica status do provider (validação REAL)
     */
    async getStatus() {
        if (!this.isConfigured()) {
            return {
                connected: false,
                configured: false,
                provider: this.provider,
                message: `${this.provider.toUpperCase()} não configurado.`,
            };
        }

        try {
            const statusPath = '/status';
            const status = await this._request('GET', statusPath);
            return {
                connected: true,
                configured: true,
                provider: 'wasenderapi',
                message: status.message || 'Conectado',
                status: status.status || 'online',
            };
        } catch (err) {
            return {
                connected: false,
                configured: true,
                provider: 'wasenderapi',
                message: `Erro ao verificar status: ${err.message}`,
            };
        }
    }

    /**
     * Retorna configuração atual do webhook
     */
    async getWebhookConfig() {
        return { supported: false, provider: this.provider };
    }

    /**
     * Atualiza URL do webhook — não suportado neste client runtime
     */
    async setWebhook(webhookUrl) {
        return { supported: false, provider: this.provider, webhookUrl };
    }
}

module.exports = MessagingClient;
