/**
 * A/B Testing de Prompts
 * Permite testar variantes de system prompt em paralelo.
 * Distribui usuários aleatoriamente entre variantes e rastreia performance de cada uma.
 */

class ABTesting {
    constructor() {
        // Variantes de prompt (podem ser editadas em runtime)
        this.variants = {
            A: {
                name: 'Padrão (Empática)',
                active: true,
                // Patch: instruções ADICIONAIS ao system prompt (não substitui — complementa)
                promptPatch: '',
                temperatureOverride: null,   // null = usar padrão
                maxTokensOverride: null
            },
            B: {
                name: 'Direta e Objetiva',
                active: true,
                promptPatch: `
INSTRUÇÕES ADICIONAIS (Variante B — Teste A/B):
- Seja mais DIRETA e objetiva nas respostas.
- Respostas mais curtas (máximo 3 frases por mensagem).
- Vá direto ao ponto sem rodeios.
- Menos emojis, mais foco em informação.
- Puxe para agendamento mais cedo na conversa.`,
                temperatureOverride: 0.8,
                maxTokensOverride: 200
            }
        };

        // Atribuição usuário → variante
        this.assignments = {};

        // Métricas por variante
        this.metrics = {};
        for (const key of Object.keys(this.variants)) {
            this.metrics[key] = {
                totalMessages: 0,
                totalResponseTimeMs: 0,
                totalEscalations: 0,
                totalAppointments: 0,
                totalConversations: 0,
                sentiments: { positive: 0, neutral: 0, negative: 0 },
                avgMessagesBeforeBooking: [],
                conversationLengths: []
            };
        }
    }

    /**
     * Atribui um usuário a uma variante (ou retorna a existente)
     */
    assignVariant(phone) {
        if (this.assignments[phone]) {
            return this.assignments[phone];
        }

        // Distribuição aleatória entre variantes ativas
        const activeVariants = Object.entries(this.variants)
            .filter(([_, v]) => v.active)
            .map(([key]) => key);

        if (activeVariants.length === 0) {
            return 'A'; // fallback
        }

        const idx = Math.floor(Math.random() * activeVariants.length);
        const variant = activeVariants[idx];
        this.assignments[phone] = variant;
        this.metrics[variant].totalConversations++;

        console.log(`🧪 [A/B] ${phone} atribuído à variante ${variant} (${this.variants[variant].name})`);
        return variant;
    }

    /**
     * Retorna o patch de prompt para um usuário
     */
    getPromptPatch(phone) {
        const variant = this.assignments[phone] || this.assignVariant(phone);
        return this.variants[variant]?.promptPatch || '';
    }

    /**
     * Retorna overrides de configuração para um usuário
     */
    getOverrides(phone) {
        const variant = this.assignments[phone] || 'A';
        const v = this.variants[variant];
        return {
            variant,
            temperature: v?.temperatureOverride || null,
            maxTokens: v?.maxTokensOverride || null
        };
    }

    // ===== MÉTRICAS =====

    /**
     * Registra uma mensagem processada
     */
    recordMessage(phone, { responseTimeMs = 0, sentiment = null } = {}) {
        const variant = this.assignments[phone];
        if (!variant || !this.metrics[variant]) return;

        const m = this.metrics[variant];
        m.totalMessages++;
        m.totalResponseTimeMs += responseTimeMs;

        if (sentiment && m.sentiments[sentiment] !== undefined) {
            m.sentiments[sentiment]++;
        }
    }

    /**
     * Registra escalação
     */
    recordEscalation(phone) {
        const variant = this.assignments[phone];
        if (variant && this.metrics[variant]) {
            this.metrics[variant].totalEscalations++;
        }
    }

    /**
     * Registra agendamento (conversão)
     */
    recordAppointment(phone) {
        const variant = this.assignments[phone];
        if (!variant || !this.metrics[variant]) return;

        this.metrics[variant].totalAppointments++;

        // Quantas mensagens foram necessárias até converter?
        // (conta pelo total de mensagens dessa conversa)
        // Simplificação: usar totalMessages/totalConversations como proxy
    }

    /**
     * Registra fim de conversa (para calcular duração média)
     */
    recordConversationEnd(phone, messageCount) {
        const variant = this.assignments[phone];
        if (variant && this.metrics[variant]) {
            this.metrics[variant].conversationLengths.push(messageCount);
            if (this.metrics[variant].conversationLengths.length > 200) {
                this.metrics[variant].conversationLengths.shift();
            }
        }
    }

    // ===== GESTÃO DE VARIANTES =====

    /**
     * Adiciona ou atualiza uma variante
     */
    setVariant(key, { name, promptPatch, temperatureOverride = null, maxTokensOverride = null, active = true }) {
        this.variants[key] = { name, promptPatch, temperatureOverride, maxTokensOverride, active };
        if (!this.metrics[key]) {
            this.metrics[key] = {
                totalMessages: 0, totalResponseTimeMs: 0,
                totalEscalations: 0, totalAppointments: 0,
                totalConversations: 0,
                sentiments: { positive: 0, neutral: 0, negative: 0 },
                avgMessagesBeforeBooking: [], conversationLengths: []
            };
        }
    }

    /**
     * Desativa uma variante (novos usuários não serão atribuídos a ela)
     */
    deactivateVariant(key) {
        if (this.variants[key]) {
            this.variants[key].active = false;
        }
    }

    // ===== RELATÓRIO COMPARATIVO =====

    /**
     * Retorna relatório comparativo entre variantes
     */
    getReport() {
        const report = { variants: {}, winner: null };

        for (const [key, variant] of Object.entries(this.variants)) {
            const m = this.metrics[key];
            const totalSentiments = m.sentiments.positive + m.sentiments.neutral + m.sentiments.negative;
            const avgConvLength = m.conversationLengths.length > 0
                ? +(m.conversationLengths.reduce((a, b) => a + b, 0) / m.conversationLengths.length).toFixed(1)
                : 0;

            report.variants[key] = {
                name: variant.name,
                active: variant.active,
                totalConversations: m.totalConversations,
                totalMessages: m.totalMessages,
                avgResponseTimeMs: m.totalMessages > 0 ? Math.round(m.totalResponseTimeMs / m.totalMessages) : 0,
                conversionRate: m.totalConversations > 0
                    ? ((m.totalAppointments / m.totalConversations) * 100).toFixed(1) + '%'
                    : '0.0%',
                escalationRate: m.totalConversations > 0
                    ? ((m.totalEscalations / m.totalConversations) * 100).toFixed(1) + '%'
                    : '0.0%',
                satisfactionScore: totalSentiments > 0
                    ? (((m.sentiments.positive * 1 + m.sentiments.neutral * 0.5) / totalSentiments) * 100).toFixed(1) + '%'
                    : 'N/A',
                avgConversationLength: avgConvLength,
                sentiments: m.sentiments
            };
        }

        // Determinar "vencedor" (maior conversão com mínimo de 10 conversas)
        let bestKey = null;
        let bestConversion = -1;
        for (const [key, data] of Object.entries(report.variants)) {
            const m = this.metrics[key];
            if (m.totalConversations >= 10) {
                const rate = m.totalConversations > 0 ? m.totalAppointments / m.totalConversations : 0;
                if (rate > bestConversion) {
                    bestConversion = rate;
                    bestKey = key;
                }
            }
        }

        if (bestKey) {
            report.winner = { variant: bestKey, name: this.variants[bestKey].name, conversionRate: (bestConversion * 100).toFixed(1) + '%' };
        }

        report.totalAssignments = Object.keys(this.assignments).length;
        report.distributionBalance = {};
        for (const key of Object.keys(this.variants)) {
            report.distributionBalance[key] = Object.values(this.assignments).filter(v => v === key).length;
        }

        return report;
    }

    /**
     * Imprime relatório no console
     */
    printReport() {
        const r = this.getReport();
        console.log('\n🧪 === A/B TESTING REPORT ===');
        for (const [key, data] of Object.entries(r.variants)) {
            console.log(`   [${key}] ${data.name} ${data.active ? '✅' : '⏸️'}`);
            console.log(`      Conversas: ${data.totalConversations} | Conversão: ${data.conversionRate} | Escalação: ${data.escalationRate}`);
            console.log(`      Tempo médio: ${data.avgResponseTimeMs}ms | Satisfação: ${data.satisfactionScore}`);
        }
        if (r.winner) {
            console.log(`   🏆 Vencedor provisório: Variante ${r.winner.variant} (${r.winner.name}) — ${r.winner.conversionRate} conversão`);
        } else {
            console.log(`   📊 Dados insuficientes para declarar vencedor (mín. 10 conversas/variante)`);
        }
        console.log('============================\n');
    }
}

module.exports = new ABTesting();
