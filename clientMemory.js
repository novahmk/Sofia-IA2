/**
 * Client Memory System
 * Armazena memória de cada cliente para personalização de atendimento
 * Persistido em SQLite via database.js (com fallback para JSON)
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const db = require('./database');
const MEMORY_FILE = path.join(__dirname, 'client_memories.json');

class ClientMemory {
    constructor() {
        this.memories = this.loadMemories();
        this.pendingBeforeHydration = {};
        this.dbHydrationSynced = !db || db.hydrated;

        if (db?.ready) {
            db.ready
                .then(() => {
                    this.dbHydrationSynced = true;
                    this.memories = db.getAll('client_memories');

                    for (const [phone, pendingMemory] of Object.entries(this.pendingBeforeHydration)) {
                        this.memories[phone] = this.memories[phone]
                            ? this.mergeMemoryState(this.memories[phone], pendingMemory)
                            : pendingMemory;
                    }

                    if (Object.keys(this.pendingBeforeHydration).length > 0) {
                        this.saveMemories();
                    }

                    this.pendingBeforeHydration = {};
                })
                .catch((error) => {
                    console.warn(`⚠️ Erro ao sincronizar memórias após hydrate: ${error.message}`);
                });
        }

        // Auto-sync para SQLite a cada 15s
        this.autoSaveInterval = setInterval(() => this.saveMemories(), 15000);
    }

    mergeMemoryState(existingMemory = {}, pendingMemory = {}) {
        const existingConversation = existingMemory.conversation || {};
        const pendingConversation = pendingMemory.conversation || {};
        const existingAppointments = existingMemory.appointments || {};
        const pendingAppointments = pendingMemory.appointments || {};

        return {
            ...existingMemory,
            ...pendingMemory,
            personal: {
                ...(existingMemory.personal || {}),
                ...(pendingMemory.personal || {}),
            },
            hair_health: {
                ...(existingMemory.hair_health || {}),
                ...(pendingMemory.hair_health || {}),
                concerns: [...new Set([...(existingMemory.hair_health?.concerns || []), ...(pendingMemory.hair_health?.concerns || [])])],
                allergies: [...new Set([...(existingMemory.hair_health?.allergies || []), ...(pendingMemory.hair_health?.allergies || [])])],
                medical_conditions: [...new Set([...(existingMemory.hair_health?.medical_conditions || []), ...(pendingMemory.hair_health?.medical_conditions || [])])],
            },
            conversation: {
                ...existingConversation,
                ...pendingConversation,
                total_messages: Math.max(existingConversation.total_messages || 0, pendingConversation.total_messages || 0),
                topics_discussed: [...new Set([...(existingConversation.topics_discussed || []), ...(pendingConversation.topics_discussed || [])])],
                questions_asked: [...(existingConversation.questions_asked || []), ...(pendingConversation.questions_asked || [])],
                objections: [...new Set([...(existingConversation.objections || []), ...(pendingConversation.objections || [])])],
            },
            preferences: {
                ...(existingMemory.preferences || {}),
                ...(pendingMemory.preferences || {}),
            },
            appointments: {
                ...existingAppointments,
                ...pendingAppointments,
                scheduled: [...(existingAppointments.scheduled || []), ...(pendingAppointments.scheduled || [])],
                completed: [...(existingAppointments.completed || []), ...(pendingAppointments.completed || [])],
                cancelled: [...(existingAppointments.cancelled || []), ...(pendingAppointments.cancelled || [])],
            },
            notes: [...(existingMemory.notes || []), ...(pendingMemory.notes || [])],
        };
    }

    /**
     * Carrega memórias salvas (SQLite primeiro, fallback JSON)
     */
    loadMemories() {
        if (db) {
            try {
                return db.getAll('client_memories');
            } catch (error) {
                console.warn(`⚠️ Erro ao carregar memórias do SQLite: ${error.message}`);
            }
        }
        // Fallback JSON
        try {
            if (fs.existsSync(MEMORY_FILE)) {
                return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
            }
        } catch (error) {
            console.warn(`⚠️ Erro ao carregar memórias: ${error.message}`);
        }
        return {};
    }

    /**
     * Salva memórias (SQLite + fallback JSON)
     */
    async saveMemories() {
        if (db) {
            try {
                for (const [phone, data] of Object.entries(this.memories)) {
                    db.set('client_memories', phone, data);
                }
                return;
            } catch (error) {
                console.error(`❌ Erro ao salvar no SQLite: ${error.message}`);
            }
        }
        // Fallback JSON
        try {
            await fsPromises.writeFile(MEMORY_FILE, JSON.stringify(this.memories, null, 2));
        } catch (error) {
            console.error(`❌ Erro ao salvar memórias: ${error.message}`);
        }
    }

    /**
     * Inicializa memória de um cliente
     */
    initializeClientMemory(phoneNumber) {
        if (!this.memories[phoneNumber]) {
            const newMemory = {
                phone: phoneNumber,
                created_at: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                
                // Informações pessoais
                personal: {
                    name: null,
                    location: null,
                    age_group: null
                },

                // Dados sobre saúde capilar
                hair_health: {
                    baldness_degree: null, // Norwood scale
                    hair_condition: null,
                    concerns: [],
                    allergies: [],
                    medical_conditions: []
                },

                // Histórico de conversa
                conversation: {
                    total_messages: 0,
                    first_contact: new Date().toISOString(),
                    topics_discussed: [],
                    questions_asked: [],
                    objections: []
                },

                // Preferências de atendimento
                preferences: {
                    tone: 'professional', // professional, casual, technical
                    pace: 'normal', // fast, normal, slow
                    communication_style: 'mixed', // direct, detailed, mixed
                    preferred_language: 'pt-BR',
                    time_zone: 'America/Sao_Paulo'
                },

                // Estado de interesse/compra
                funnel_stage: 'awareness', // awareness > consideration > decision > customer
                sentiment: 'neutral', // negative, neutral, positive
                purchase_likelihood: 'low', // low, medium, high
                next_step: null,

                // Histórico de agendamentos
                appointments: {
                    scheduled: [],
                    completed: [],
                    cancelled: []
                },

                // Notas da conversa
                notes: []
            };

            this.memories[phoneNumber] = newMemory;

            if (db && !this.dbHydrationSynced) {
                this.pendingBeforeHydration[phoneNumber] = newMemory;
            }

            console.log(`📝 Memória criada para ${phoneNumber}`);
        }

        return this.memories[phoneNumber];
    }

    /**
     * Recupera memória de um cliente
     */
    getClientMemory(phoneNumber) {
        return this.initializeClientMemory(phoneNumber);
    }

    /**
     * Atualiza informação pessoal
     */
    updatePersonalInfo(phoneNumber, field, value) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.personal[field] = value;
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`✅ Informação pessoal atualizada: ${phoneNumber} - ${field}: ${value}`);
        return memory;
    }

    /**
     * Atualiza dados de saúde capilar
     */
    updateHairHealth(phoneNumber, field, value) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.hair_health[field] = value;
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`✅ Saúde capilar atualizada: ${phoneNumber} - ${field}: ${value}`);
        return memory;
    }

    /**
     * Registra tópico discutido
     */
    recordTopicDiscussed(phoneNumber, topic) {
        const memory = this.initializeClientMemory(phoneNumber);
        if (!memory.conversation.topics_discussed.includes(topic)) {
            memory.conversation.topics_discussed.push(topic);
        }
        memory.conversation.total_messages++;
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        return memory;
    }

    /**
     * Registra pergunta feita
     */
    recordQuestion(phoneNumber, question) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.conversation.questions_asked.push({
            question,
            timestamp: new Date().toISOString()
        });
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        return memory;
    }

    /**
     * Registra objeção do cliente
     */
    recordObjection(phoneNumber, objection) {
        const memory = this.initializeClientMemory(phoneNumber);
        if (!memory.conversation.objections.includes(objection)) {
            memory.conversation.objections.push(objection);
        }
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        return memory;
    }

    /**
     * Atualiza sentimento/emoção do cliente
     */
    updateSentiment(phoneNumber, sentiment) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.sentiment = sentiment; // negative, neutral, positive
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`💭 Sentimento atualizado: ${phoneNumber} - ${sentiment}`);
        return memory;
    }

    /**
     * Atualiza estágio do funil
     */
    updateFunnelStage(phoneNumber, stage) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.funnel_stage = stage; // awareness, consideration, decision, customer
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`📊 Funil atualizado: ${phoneNumber} - ${stage}`);
        return memory;
    }

    /**
     * Atualiza preferência de atendimento
     */
    updatePreference(phoneNumber, field, value) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.preferences[field] = value;
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`⚙️ Preferência atualizada: ${phoneNumber} - ${field}: ${value}`);
        return memory;
    }

    /**
     * Registra agendamento
     */
    recordAppointment(phoneNumber, appointmentData) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.appointments.scheduled.push({
            ...appointmentData,
            scheduled_at: new Date().toISOString()
        });
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`📅 Agendamento registrado: ${phoneNumber}`);
        return memory;
    }

    /**
     * Adiciona nota
     */
    addNote(phoneNumber, note) {
        const memory = this.initializeClientMemory(phoneNumber);
        memory.notes.push({
            note,
            timestamp: new Date().toISOString()
        });
        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`📌 Nota adicionada: ${phoneNumber}`);
        return memory;
    }

    /**
     * Cria contexto de memória para Sofia
     */
    createMemoryContext(phoneNumber) {
        const memory = this.getClientMemory(phoneNumber);

        if (!memory.personal.name && memory.conversation.topics_discussed.length === 0) {
            return ''; // Sem memória útil
        }

        const parts = [];

        // Essencial: nome
        if (memory.personal.name) {
            parts.push(`Nome: ${memory.personal.name}`);
        }

        // Saúde capilar
        if (memory.hair_health.concerns.length > 0) {
            parts.push(`Preocupações: ${memory.hair_health.concerns.join(', ')}`);
        }

        // Tópicos já cobertos (CRÍTICO para anti-repetição)
        if (memory.conversation.topics_discussed.length > 0) {
            parts.push(`Já discutido: ${memory.conversation.topics_discussed.join(', ')}`);
        }

        // Objeções (importante para não repetir argumentos)
        if (memory.conversation.objections.length > 0) {
            parts.push(`Objeções: ${memory.conversation.objections.join(', ')}`);
        }

        // Próximo passo
        if (memory.next_step) {
            parts.push(`Próximo passo: ${memory.next_step}`);
        }

        if (parts.length === 0) return '';

        return `[MEMÓRIA] ${parts.join(' | ')}`;
    }

    // ===== LGPD — Lei Geral de Proteção de Dados =====

    /**
     * Direito ao Esquecimento — Apaga todos os dados de um cliente
     * LGPD Art. 18, VI
     */
    deleteClientData(phoneNumber) {
        if (!this.memories[phoneNumber]) {
            return { success: false, message: 'Nenhum dado encontrado para este número' };
        }

        delete this.memories[phoneNumber];
        
        // Apagar do SQLite também (todas as tabelas)
        if (db) {
            db.deleteAllClientData(phoneNumber);
        }
        this.saveMemories();

        console.log(`🗑️ [LGPD] Dados do cliente ${phoneNumber} apagados permanentemente`);
        return {
            success: true,
            message: `Todos os dados do número ${phoneNumber} foram apagados conforme LGPD`,
            deletedAt: new Date().toISOString()
        };
    }

    /**
     * Portabilidade de Dados — Exporta todos os dados de um cliente
     * LGPD Art. 18, V
     */
    exportClientData(phoneNumber) {
        const memory = this.memories[phoneNumber];
        if (!memory) {
            return { success: false, message: 'Nenhum dado encontrado para este número' };
        }

        console.log(`📦 [LGPD] Dados do cliente ${phoneNumber} exportados`);
        return {
            success: true,
            exportedAt: new Date().toISOString(),
            dataOwner: phoneNumber,
            data: JSON.parse(JSON.stringify(memory)) // deep copy
        };
    }

    /**
     * Registra consentimento do cliente para tratamento de dados
     * LGPD Art. 7, I
     */
    recordConsent(phoneNumber, consentType = 'data_processing') {
        const memory = this.initializeClientMemory(phoneNumber);
        if (!memory.lgpd) {
            memory.lgpd = { consents: [], dataRequests: [] };
        }

        memory.lgpd.consents.push({
            type: consentType,
            grantedAt: new Date().toISOString(),
            active: true
        });

        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`✅ [LGPD] Consentimento '${consentType}' registrado para ${phoneNumber}`);
        return memory;
    }

    /**
     * Revoga consentimento do cliente
     * LGPD Art. 8, §5
     */
    revokeConsent(phoneNumber, consentType = 'data_processing') {
        const memory = this.memories[phoneNumber];
        if (!memory || !memory.lgpd) {
            return { success: false, message: 'Nenhum consentimento encontrado' };
        }

        const consent = memory.lgpd.consents.find(c => c.type === consentType && c.active);
        if (consent) {
            consent.active = false;
            consent.revokedAt = new Date().toISOString();
        }

        memory.last_updated = new Date().toISOString();
        this.saveMemories();

        console.log(`🚫 [LGPD] Consentimento '${consentType}' revogado para ${phoneNumber}`);
        return { success: true, message: `Consentimento '${consentType}' revogado` };
    }

    /**
     * Lista todos os clientes armazenados (para auditoria LGPD)
     */
    listAllClients() {
        return Object.keys(this.memories).map(phone => ({
            phone,
            name: this.memories[phone]?.personal?.name || 'Desconhecido',
            createdAt: this.memories[phone]?.created_at,
            lastUpdated: this.memories[phone]?.last_updated,
            hasConsent: this.memories[phone]?.lgpd?.consents?.some(c => c.active) || false
        }));
    }

    /**
     * Cleanup ao encerrar
     */
    destroy() {
        clearInterval(this.autoSaveInterval);
        this.saveMemories();
    }
}

module.exports = new ClientMemory();
