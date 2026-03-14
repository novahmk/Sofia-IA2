/**
 * Messaging Client — Integração com Twilio WhatsApp API
 */

const twilio = require('twilio');

class MessagingClient {
    constructor() {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        this.fromNumber = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

        if (!accountSid || !authToken) {
            console.warn('⚠️ TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN não configurados no .env');
            this.client = null;
        } else {
            this.client = twilio(accountSid, authToken);
            console.log('📡 Messaging Client Twilio inicializado com sucesso');
        }
    }

    /**
     * Formata número para o padrão Twilio WhatsApp
     * Aceita: "5511999999999", "5511999999999@c.us", "whatsapp:+5511999999999"
     */
    _formatNumber(phoneNumber) {
        if (phoneNumber.startsWith('whatsapp:')) return phoneNumber;
        const cleaned = phoneNumber.replace('@c.us', '').replace(/\D/g, '');
        return `whatsapp:+${cleaned}`;
    }

    /**
     * Envia mensagem de texto via Twilio WhatsApp
     */
    async sendMessage(phoneNumber, message) {
        if (!this.client) {
            console.log(`📤 [MOCK] Mensagem para ${phoneNumber}: "${message.substring(0, 80)}..."`);
            return;
        }

        const to = this._formatNumber(phoneNumber);
        const result = await this.client.messages.create({
            from: this.fromNumber,
            to,
            body: message
        });
        console.log(`📤 [Twilio] Mensagem enviada para ${to} | SID: ${result.sid}`);
        return result;
    }

    /**
     * Envia indicador de "digitando..." (Twilio não suporta nativamente)
     */
    async sendTyping(phoneNumber) {
        // Twilio WhatsApp API não suporta indicador de typing
    }

    /**
     * Para o indicador de "digitando..." (Twilio não suporta nativamente)
     */
    async stopTyping(phoneNumber) {
        // Twilio WhatsApp API não suporta indicador de typing
    }

    /**
     * Verifica o status da conexão com a API Twilio
     */
    async getStatus() {
        if (!this.client) {
            return { connected: false, message: 'Twilio não configurado. Verifique TWILIO_ACCOUNT_SID e TWILIO_AUTH_TOKEN no .env' };
        }
        try {
            const account = await this.client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
            return { connected: true, message: `Twilio conectado — Conta: ${account.friendlyName}, Status: ${account.status}` };
        } catch (err) {
            return { connected: false, message: `Erro ao verificar Twilio: ${err.message}` };
        }
    }
}

module.exports = MessagingClient;
