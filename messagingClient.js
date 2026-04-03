/**
 * Messaging Client — Camada de abstração para envio/recebimento de mensagens via UAZAPI
 * Docs: https://docs.uazapi.com
 */

const https = require('https');

class MessagingClient {
    constructor() {
        this.token = process.env.UAZAPI_TOKEN || '';
        this.baseUrl = (process.env.UAZAPI_BASE_URL || 'https://free.uazapi.com').replace(/\/$/, '');
        this._parsedUrl = null;

        try {
            this._parsedUrl = new URL(this.baseUrl);
        } catch (e) {
            console.error('❌ UAZAPI_BASE_URL inválida:', this.baseUrl);
        }

        console.log(`📡 Messaging Client inicializado (${this.isConfigured() ? 'UAZAPI configurado — ' + this.baseUrl : 'UAZAPI não configurado'})`);
    }

    isConfigured() {
        return Boolean(this.token && this._parsedUrl);
    }

    /**
     * Normaliza número de telefone para formato UAZAPI (apenas dígitos)
     */
    normalizePhoneNumber(phoneNumber) {
        return String(phoneNumber || '')
            .replace(/^whatsapp:/, '')
            .replace(/[^0-9]/g, '')
            .trim();
    }

    /**
     * Faz request HTTPS genérica para a UAZAPI
     */
    _request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            if (!this.isConfigured()) {
                reject(new Error('UAZAPI não configurado. Defina UAZAPI_TOKEN e UAZAPI_BASE_URL.'));
                return;
            }

            const url = new URL(path, this.baseUrl);
            const headers = {
                'token': this.token,
            };

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
                        reject(new Error(`UAZAPI HTTP ${res.statusCode}: ${msg}`));
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('UAZAPI timeout (15s)')); });

            if (postData) req.write(postData);
            req.end();
        });
    }

    /**
     * Envia mensagem de texto via UAZAPI
     */
    async sendMessage(phoneNumber, message) {
        if (!this.isConfigured()) {
            console.warn('⚠️ UAZAPI não configurado. Mensagem não enviada.');
            return { queued: false, reason: 'uazapi_not_configured' };
        }

        const phone = this.normalizePhoneNumber(phoneNumber);
        const response = await this._request('POST', '/send/text', {
            phone,
            chatId: `${phone}@s.whatsapp.net`,
            message,
        });

        console.log(`📤 [UAZAPI] Mensagem para ${phone}: "${message.substring(0, 80)}..."`);
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
     * Verifica status da instância UAZAPI (validação REAL)
     */
    async getStatus() {
        if (!this.isConfigured()) {
            return {
                connected: false,
                configured: false,
                provider: 'uazapi',
                message: 'UAZAPI não configurado. Defina UAZAPI_TOKEN e UAZAPI_BASE_URL.',
            };
        }

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
