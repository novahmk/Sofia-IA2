/**
 * Topic Blacklist
 * Impede que Sofia discuta tópicos proibidos ou sensíveis.
 * Tópicos configuráveis via arquivo ou variável de ambiente.
 */

// Tópicos bloqueados por padrão (regex patterns)
const DEFAULT_BLACKLIST = [
    // Concorrentes — não mencionar outras clínicas
    { pattern: /\b(hair\s*brasil|implachair|spamedica|bernstein|bosley|artas)\b/i, topic: 'concorrentes', response: 'Prefiro não comentar sobre outras clínicas. Posso te contar sobre o que a Quality Hair oferece?' },

    // Política e religião
    { pattern: /\b(pol[ií]tic[oa]|partido|elei[çc][ãa]o|candidat|voto|presidente|governador|bolsonaro|lula|religi[ãa]o|igreja|deus|bíblia|cor[ãa]o)\b/i, topic: 'política_religião', response: 'Esse é um assunto fora da minha área. Posso te ajudar com algo sobre transplante capilar?' },

    // Receitas médicas e medicamentos controlados
    { pattern: /\b(receit[ae]\s+m[ée]dic|prescrever|prescri[çc]|minoxidil\s+dose|finasterida\s+dose|dutasterida|dosagem|mg\s+por\s+dia)\b/i, topic: 'prescrição_médica', response: 'Não posso prescrever medicamentos. Esse tipo de orientação deve vir do médico na consulta. Posso te ajudar a agendar?' },

    // Dados pessoais de outros clientes
    { pattern: /\b(dados?\s+de\s+outro|informa[çc][ãa]o\s+de\s+outro|quem\s+mais|outro\s+paciente|lista\s+de\s+client)\b/i, topic: 'dados_terceiros', response: 'Não posso compartilhar informações de outros pacientes por questões de privacidade (LGPD).' },

    // Procedimentos que a clínica não faz
    { pattern: /\b(botox|lipoaspira|rinoplast|silicone|abdominoplast|bariátrica|bichectomia)\b/i, topic: 'procedimentos_não_oferecidos', response: 'A Quality Hair é especializada em transplante capilar. Esse procedimento não faz parte dos nossos serviços. Posso te ajudar com algo sobre cabelos?' },

    // Conteúdo inapropriado
    { pattern: /\b(sex[uo]|porn|nud|drogas?\b|maconha|cocaína|trafic)\b/i, topic: 'conteúdo_inapropriado', response: 'Esse assunto está fora do que posso ajudar. Estou aqui para tirar dúvidas sobre transplante capilar.' }
];

class TopicBlacklist {
    constructor() {
        this.rules = [...DEFAULT_BLACKLIST];
        this.blockedLog = []; // Últimas 50 ocorrências
    }

    /**
     * Adiciona regra personalizada
     * @param {string} regexStr - Padrão regex como string
     * @param {string} topic - Nome do tópico
     * @param {string} response - Mensagem de defleção
     */
    addRule(regexStr, topic, response) {
        this.rules.push({
            pattern: new RegExp(regexStr, 'i'),
            topic,
            response
        });
    }

    /**
     * Remove regra por nome de tópico
     */
    removeRule(topic) {
        this.rules = this.rules.filter(r => r.topic !== topic);
    }

    /**
     * Verifica se uma mensagem contém tópicos bloqueados
     * @param {string} message - Mensagem do usuário
     * @param {string} phone - Telefone do remetente
     * @returns {{ blocked: boolean, topic: string|null, deflectionResponse: string|null }}
     */
    check(message, phone) {
        if (!message || typeof message !== 'string') {
            return { blocked: false, topic: null, deflectionResponse: null };
        }

        for (const rule of this.rules) {
            if (rule.pattern.test(message)) {
                this._logBlocked(phone, rule.topic, message);
                console.log(`🚫 [Blacklist] Tópico bloqueado de ${phone}: "${rule.topic}"`);
                return {
                    blocked: true,
                    topic: rule.topic,
                    deflectionResponse: rule.response
                };
            }
        }

        return { blocked: false, topic: null, deflectionResponse: null };
    }

    /**
     * Registra ocorrência bloqueada
     */
    _logBlocked(phone, topic, message) {
        this.blockedLog.push({
            timestamp: new Date().toISOString(),
            phone,
            topic,
            preview: message.substring(0, 80)
        });
        if (this.blockedLog.length > 50) {
            this.blockedLog.shift();
        }
    }

    /**
     * Retorna relatório
     */
    getReport() {
        const topicCounts = {};
        for (const entry of this.blockedLog) {
            topicCounts[entry.topic] = (topicCounts[entry.topic] || 0) + 1;
        }

        return {
            totalBlocked: this.blockedLog.length,
            activeRules: this.rules.length,
            topicCounts,
            recentBlocked: this.blockedLog.slice(-10),
            rulesList: this.rules.map(r => ({ topic: r.topic, pattern: r.pattern.source }))
        };
    }
}

module.exports = new TopicBlacklist();
