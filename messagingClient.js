/**
 * Messaging Client — Camada de abstração para envio/recebimento de mensagens.
 * Suporta UAZAPI e WASenderAPI conforme configuração.
 */

const https = require('https');

class MessagingClient {
    constructor() {
        this.provider = process.env.WASENDERAPI_BASE_URL ? 'wasenderapi' : 'uazapi';

        if (this.provider === 'wasenderapi') {
            this.token = process.env.WASENDERAPI_TOKEN || '';
            this.baseUrl = (process.env.WASENDERAPI_BASE_URL || '').replace(/\/$/, '');
            this.sendPath = '/api/send-message';
        } else {
            this.token = process.env.UAZAPI_TOKEN || '';
            this.baseUrl = (process.env.UAZAPI_BASE_URL || 'https://free.uazapi.com').replace(/\/$/, '');
            this.sendPath = '/send/text';
        }

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
        if (this.provider === 'wasenderapi') {
            return {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            };
        }
        return {
            'token': this.token,
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
     * Envia mensagem de texto via provider configurado (UAZAPI ou WASenderAPI)
     */
    async sendMessage(phoneNumber, message) {
        if (!this.isConfigured()) {
            console.warn(`⚠️ ${this.provider.toUpperCase()} não configurado. Mensagem não enviada.`);
            return { queued: false, reason: `${this.provider}_not_configured` };
        }

        const phone = this.normalizePhoneNumber(phoneNumber);
        let payload = {};

        if (this.provider === 'wasenderapi') {
            // WASenderAPI payload
            payload = {
                to: phone,
                text: message,
            };
        } else {
            // UAZAPI payload
            payload = {
                phone,
                chatId: `${phone}@s.whatsapp.net`,
                message,
            };
        }

        const response = await this._request('POST', this.sendPath, payload);
        console.log(`📤 [${this.provider.toUpperCase()}] Mensagem para ${phone}: "${message.substring(0, 80)}..."`);
        return response;
    }

    /**
     * Simula "digitando..." — UAZAPI não suporta este endpoint no free
     */
    async sendTyping(phoneNumber) {
        // UAZAPI free não tem endpoint de presença
        return { supported: false, phoneNumber };
    }

    /**
     * Para de "digitar" — UAZAPI não suporta no free
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

        if (this.provider === 'wasenderapi') {
            try {
                // WASenderAPI simples health check
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
        } else {
            // UAZAPI status check
            try {
                const status = await this._request('GET', '/status');
                const instance = status.status?.checked_instance || {};
                return {
                    connected: instance.connection_status === 'connected',
                    configured: true,
                    provider: 'uazapi',
                    instanceName: instance.name || '',
                    connectionStatus: instance.connection_status || 'unknown',
                    isHealthy: instance.is_healthy || false,
                    serverStatus: status.status?.server_status || 'unknown',
                    message: instance.message || '',
                };
            } catch (err) {
                return {
                    connected: false,
                    configured: true,
                    provider: 'uazapi',
                    message: `Erro ao verificar status: ${err.message}`,
                };
            }
        }
    }

    /**
     * Retorna configuração atual do webhook
     */
    async getWebhookConfig() {
        return this._request('GET', '/webhook');
    }

    /**
     * Atualiza URL do webhook na UAZAPI
     */
    async setWebhook(webhookUrl) {
        return this._request('PUT', '/webhook', {
            url: `POST ${webhookUrl}`,
            enabled: true,
            events: ['messages'],
            addUrlEvents: false,
            addUrlTypesMessages: false,
        });
    }
}

module.exports = MessagingClient;
