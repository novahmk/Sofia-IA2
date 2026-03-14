/**
 * Conversation Manager
 * Gerencia estados de conversas e detecta quando um humano está engajado
 * Permite transição de atendimento automático (Sofia) para humano (gerente)
 * Persistido em SQLite via database.js (com fallback para JSON)
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const db = require('./database');
const CONVERSATION_STATE_FILE = path.join(__dirname, 'conversation_states.json');

class ConversationManager {
    constructor() {
        this.states = this.loadStates();
        this.autoSaveInterval = setInterval(() => this.saveStates(), 30000);
    }

    /**
     * Carrega estados anteriores (SQLite primeiro, fallback JSON)
     */
    loadStates() {
        if (db) {
            try {
                return db.getAll('conversation_states');
            } catch (error) {
                console.warn(`⚠️ Erro ao carregar estados do SQLite: ${error.message}`);
            }
        }
        try {
            if (fs.existsSync(CONVERSATION_STATE_FILE)) {
                const data = fs.readFileSync(CONVERSATION_STATE_FILE, 'utf-8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.warn(`⚠️ Não foi possível carregar estados anteriores: ${error.message}`);
        }
        return {};
    }

    /**
     * Salva estados (SQLite + fallback JSON)
     */
    async saveStates() {
        if (db) {
            try {
                for (const [phone, data] of Object.entries(this.states)) {
                    db.set('conversation_states', phone, data);
                }
                return;
            } catch (error) {
                console.error(`❌ Erro ao salvar estados no SQLite: ${error.message}`);
            }
        }
        try {
            await fsPromises.writeFile(CONVERSATION_STATE_FILE, JSON.stringify(this.states, null, 2));
        } catch (error) {
            console.error(`❌ Erro ao salvar estados: ${error.message}`);
        }
    }

    /**
     * Inicializa o estado de uma conversa
     */
    initializeConversation(phoneNumber) {
        if (!this.states[phoneNumber]) {
            this.states[phoneNumber] = {
                status: 'active', // active, paused, dormant
                mode: 'auto', // auto (Sofia), manual (humano)
                sofiaActive: true,
                humanEngaged: false,
                firstMessageTime: Date.now(),
                lastMessageTime: Date.now(),
                messageCount: 0,
                humanTakeoverTime: null,
                autoResumeTime: null,
                conversationHistory: []
            };
            console.log(`📋 Nova conversa iniciada para ${phoneNumber}`);
        }
        return this.states[phoneNumber];
    }

    /**
     * Detecta se é um comando de controle
     */
    isControlCommand(message) {
        const lowerMessage = message.toLowerCase().trim();
        
        const commands = {
            humanMode: ['/humanmode', '/h', '/humano', '/manual'],
            autoMode: ['/automode', '/a', '/auto', '/automatico', '/sofia'],
            status: ['/status', '/s', '/state', '/estado'],
            forceAuto: ['/force-auto', '/fa', '/forcauto'],
            info: ['/info', '/help', '/ajuda', '/?']
        };

        for (const [command, triggers] of Object.entries(commands)) {
            if (triggers.includes(lowerMessage)) {
                return { isCommand: true, command, fullMessage: message };
            }
        }

        return { isCommand: false, command: null };
    }

    /**
     * Processa comando de controle
     */
    processCommand(phoneNumber, command) {
        const state = this.initializeConversation(phoneNumber);
        let response = '';

        switch (command) {
            case 'humanMode':
                state.mode = 'manual';
                state.sofiaActive = false;
                state.humanEngaged = true;
                state.humanTakeoverTime = Date.now();
                response = `
✅ MODO HUMANO ATIVADO
🤐 Sofia foi colocada em pausa.
📞 Você está conversando diretamente com o lead.

Comandos úteis:
- /automode ou /auto: Retorna Sofia ao atendimento
- /status: Mostra estado atual da conversa
- /humanmode ou /h: Confirma modo humano ativo
`;
                console.log(`🚨 MODO HUMANO ATIVADO para ${phoneNumber}`);
                break;

            case 'autoMode':
                state.mode = 'auto';
                state.sofiaActive = true;
                state.humanEngaged = false;
                state.autoResumeTime = Date.now();
                response = `
✅ MODO AUTOMÁTICO REATIVADO
🤖 Sofia voltou ao atendimento automático.
💬 Próximas mensagens serão respondidas automaticamente.

Comandos úteis:
- /humanmode ou /h: Ativa modo humano
- /status: Mostra estado atual
`;
                console.log(`✅ MODO AUTOMÁTICO REATIVADO para ${phoneNumber}`);
                break;

            case 'status':
                response = `
📊 STATUS DA CONVERSA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Modo: ${state.mode === 'auto' ? '🤖 Automático (Sofia)' : '👤 Manual (Você)'}
Sofia Ativa: ${state.sofiaActive ? '✅ Sim' : '❌ Não'}
Humano Engajado: ${state.humanEngaged ? '✅ Sim' : '❌ Não'}
Total de Mensagens: ${state.messageCount}
Tempo de Conversa: ${Math.round((Date.now() - state.firstMessageTime) / 1000)}s

Lead: ${phoneNumber}
${state.humanTakeoverTime ? `Modo Humano desde: ${new Date(state.humanTakeoverTime).toLocaleTimeString('pt-BR')}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
                break;

            case 'forceAuto':
                state.mode = 'auto';
                state.sofiaActive = true;
                state.humanEngaged = false;
                state.autoResumeTime = Date.now();
                response = `⚙️ Modo automático forçado reativado.`;
                console.log(`⚠️ FORÇA AUTO reativado para ${phoneNumber}`);
                break;

            case 'info':
                response = `
❓ COMANDOS DISPONÍVEIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/humanmode ou /h - Ativa modo humano (Sofia em pausa)
/automode ou /auto - Volta Sofia ao atendimento
/status ou /s - Mostra estado da conversa
/force-auto ou /fa - Força modo automático
/help ou /info - Mostra esta mensagem
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                break;

            default:
                response = '❌ Comando não reconhecido. Digite /help para ver opções.';
        }

        this.saveStates();
        return response;
    }

    /**
     * Registra mensagem na conversa
     */
    recordMessage(phoneNumber, sender, messageText) {
        const state = this.initializeConversation(phoneNumber);
        state.lastMessageTime = Date.now();
        state.messageCount++;
        
        state.conversationHistory?.push({
            timestamp: new Date().toISOString(),
            sender, // "client" ou "sofia" ou "human"
            text: messageText.substring(0, 100) // Trunca para log
        });

        // Manter apenas últimas 50 mensagens no histórico
        if (state.conversationHistory.length > 50) {
            state.conversationHistory.shift();
        }
    }

    /**
     * Verifica se Sofia deve responder
     */
    shouldSofiaRespond(phoneNumber) {
        const state = this.initializeConversation(phoneNumber);
        
        if (state.mode === 'manual' || !state.sofiaActive || state.humanEngaged) {
            return false;
        }
        return true;
    }

    /**
     * Marca engajamento humano
     */
    setHumanEngaged(phoneNumber, engaged = true) {
        const state = this.initializeConversation(phoneNumber);
        state.humanEngaged = engaged;
        
        if (engaged) {
            state.mode = 'manual';
            state.sofiaActive = false;
            state.humanTakeoverTime = Date.now();
            console.log(`👤 Humano engajado com ${phoneNumber}`);
        } else {
            console.log(`👤 Humano desengajado de ${phoneNumber}`);
        }
        
        this.saveStates();
    }

    /**
     * Obtém informações da conversa
     */
    getConversationInfo(phoneNumber) {
        return this.initializeConversation(phoneNumber);
    }

    /**
     * Reseta estado de uma conversa
     */
    resetConversation(phoneNumber) {
        delete this.states[phoneNumber];
        this.saveStates();
        console.log(`🔄 Conversa resetada para ${phoneNumber}`);
    }

    /**
     * Cleanup ao encerrar
     */
    destroy() {
        clearInterval(this.autoSaveInterval);
        this.saveStates();
    }
}

// Exporta singleton
const manager = new ConversationManager();
module.exports = manager;
