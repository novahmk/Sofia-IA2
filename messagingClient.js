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

class MessagingClient {
    constructor() {
        // TODO: Configurar sua nova API aqui
        // Exemplo:
        // this.apiKey = process.env.MESSAGING_API_KEY;
        // this.instanceId = process.env.MESSAGING_INSTANCE_ID;
        
        console.log('📡 Messaging Client inicializado (aguardando configuração de API)');
    }

    /**
     * Envia mensagem de texto para um número
     * @param {string} phoneNumber - Número no formato internacional (ex: 5511999999999)
     * @param {string} message - Texto da mensagem
     */
    async sendMessage(phoneNumber, message) {
        // TODO: Implementar com sua nova API
        // Exemplo com fetch:
        // await fetch(`${this.baseUrl}/send-text`, {
        //     method: 'POST',
        //     headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        //     body: JSON.stringify({ phone: phoneNumber, message })
        // });
        
        console.log(`📤 [MessagingClient] Mensagem para ${phoneNumber}: "${message.substring(0, 80)}..."`);
    }

    /**
     * Envia indicador de "digitando..." para um número
     * @param {string} phoneNumber
     */
    async sendTyping(phoneNumber) {
        // TODO: Implementar com sua nova API (se suportar)
        // Muitas APIs suportam: POST /send-typing { phone }
    }

    /**
     * Para o indicador de "digitando..."
     * @param {string} phoneNumber
     */
    async stopTyping(phoneNumber) {
        // TODO: Implementar com sua nova API (se suportar)
    }

    /**
     * Verifica o status da conexão com a API
     * @returns {object} Status da conexão
     */
    async getStatus() {
        // TODO: Implementar com sua nova API
        return { connected: false, message: 'API de mensagens não configurada. Implemente messagingClient.js' };
    }
}

module.exports = MessagingClient;
