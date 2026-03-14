/**
 * KPI Tracker — Métricas Avançadas da Sofia
 * Rastreia KPIs de negócio: tempo médio de resposta, taxa de conversão,
 * engajamento, satisfação estimada, funil de vendas e mais.
 */

class KPITracker {
    constructor() {
        this.sessions = {};       // Dados por telefone
        this.global = {
            totalConversations: 0,
            totalMessages: 0,
            totalResponseTimeMs: 0,
            totalEscalations: 0,
            totalAppointments: 0,
            funnelTransitions: { awareness: 0, consideration: 0, decision: 0, customer: 0 },
            intentDistribution: {},
            hourlyVolume: {},       // { "14": 42, "15": 38 }
            dailyVolume: {},        // { "2026-03-14": 120 }
            sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
            mediaTypes: { text: 0, audio: 0, image: 0, video: 0, document: 0 },
            responseTimes: [],      // últimos 500 para cálculo de percentis
            messagesByDay: {}
        };
    }

    // ===== REGISTRO DE EVENTOS =====

    /**
     * Registra uma mensagem processada com seu tempo de resposta
     */
    recordMessage(phone, {
        responseTimeMs,
        mediaType = 'text',
        intent = null,
        funnelStage = null,
        sentiment = null,
        wasEscalated = false,
        hadFunctionCall = false,
        userWordCount = 0,
        sofiaWordCount = 0
    } = {}) {
        // Sessão do usuário
        if (!this.sessions[phone]) {
            this.sessions[phone] = {
                firstMessage: Date.now(),
                lastMessage: Date.now(),
                messageCount: 0,
                totalResponseTime: 0,
                intents: [],
                funnelStages: [],
                escalated: false,
                appointmentBooked: false,
                sentiments: []
            };
            this.global.totalConversations++;
        }

        const session = this.sessions[phone];
        session.lastMessage = Date.now();
        session.messageCount++;
        session.totalResponseTime += responseTimeMs || 0;

        if (intent) session.intents.push(intent);
        if (funnelStage) {
            if (!session.funnelStages.includes(funnelStage)) {
                session.funnelStages.push(funnelStage);
                this.global.funnelTransitions[funnelStage] = (this.global.funnelTransitions[funnelStage] || 0) + 1;
            }
        }
        if (sentiment) {
            session.sentiments.push(sentiment);
            this.global.sentimentCounts[sentiment] = (this.global.sentimentCounts[sentiment] || 0) + 1;
        }
        if (wasEscalated) {
            session.escalated = true;
            this.global.totalEscalations++;
        }

        // Global
        this.global.totalMessages++;
        this.global.totalResponseTimeMs += responseTimeMs || 0;
        this.global.mediaTypes[mediaType] = (this.global.mediaTypes[mediaType] || 0) + 1;

        if (intent) {
            this.global.intentDistribution[intent] = (this.global.intentDistribution[intent] || 0) + 1;
        }

        // Distribuição horária
        const hour = String(new Date().getHours());
        this.global.hourlyVolume[hour] = (this.global.hourlyVolume[hour] || 0) + 1;

        // Distribuição diária
        const day = new Date().toISOString().split('T')[0];
        this.global.dailyVolume[day] = (this.global.dailyVolume[day] || 0) + 1;

        // Response times para percentis (últimos 500)
        if (responseTimeMs) {
            this.global.responseTimes.push(responseTimeMs);
            if (this.global.responseTimes.length > 500) {
                this.global.responseTimes.shift();
            }
        }
    }

    /**
     * Registra agendamento convertido
     */
    recordAppointment(phone) {
        this.global.totalAppointments++;
        if (this.sessions[phone]) {
            this.sessions[phone].appointmentBooked = true;
        }
    }

    // ===== CÁLCULOS =====

    /**
     * Calcula percentil de um array ordenado
     */
    _percentile(arr, p) {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
    }

    /**
     * Média de mensagens por conversa
     */
    get avgMessagesPerConversation() {
        if (this.global.totalConversations === 0) return 0;
        return +(this.global.totalMessages / this.global.totalConversations).toFixed(1);
    }

    /**
     * Tempo médio de resposta da IA (ms)
     */
    get avgResponseTimeMs() {
        if (this.global.totalMessages === 0) return 0;
        return Math.round(this.global.totalResponseTimeMs / this.global.totalMessages);
    }

    /**
     * Taxa de conversão (% de conversas que geraram agendamento)
     */
    get conversionRate() {
        if (this.global.totalConversations === 0) return '0.0%';
        const converted = Object.values(this.sessions).filter(s => s.appointmentBooked).length;
        return ((converted / this.global.totalConversations) * 100).toFixed(1) + '%';
    }

    /**
     * Taxa de escalação (% de conversas escaladas para humano)
     */
    get escalationRate() {
        if (this.global.totalConversations === 0) return '0.0%';
        const escalated = Object.values(this.sessions).filter(s => s.escalated).length;
        return ((escalated / this.global.totalConversations) * 100).toFixed(1) + '%';
    }

    /**
     * Satisfação estimada baseada na distribuição de sentimentos
     */
    get estimatedSatisfaction() {
        const { positive, neutral, negative } = this.global.sentimentCounts;
        const total = positive + neutral + negative;
        if (total === 0) return 'N/A';
        // Score: positive = 1, neutral = 0.5, negative = 0
        const score = ((positive * 1 + neutral * 0.5 + negative * 0) / total) * 100;
        return score.toFixed(1) + '%';
    }

    // ===== RELATÓRIOS =====

    /**
     * Retorna KPIs completos para o endpoint /metrics
     */
    getReport() {
        const rt = this.global.responseTimes;

        return {
            overview: {
                totalConversations: this.global.totalConversations,
                totalMessages: this.global.totalMessages,
                totalAppointments: this.global.totalAppointments,
                totalEscalations: this.global.totalEscalations
            },
            averages: {
                avgResponseTimeMs: this.avgResponseTimeMs,
                avgMessagesPerConversation: this.avgMessagesPerConversation,
                p50ResponseTimeMs: this._percentile(rt, 50),
                p95ResponseTimeMs: this._percentile(rt, 95),
                p99ResponseTimeMs: this._percentile(rt, 99)
            },
            rates: {
                conversionRate: this.conversionRate,
                escalationRate: this.escalationRate,
                estimatedSatisfaction: this.estimatedSatisfaction
            },
            funnel: this.global.funnelTransitions,
            sentiment: this.global.sentimentCounts,
            intentDistribution: this.global.intentDistribution,
            mediaTypes: this.global.mediaTypes,
            hourlyVolume: this.global.hourlyVolume,
            dailyVolume: this.global.dailyVolume,
            activeSessions: Object.keys(this.sessions).length
        };
    }

    /**
     * Imprime resumo no console
     */
    printReport() {
        const r = this.getReport();
        console.log('\n📈 === KPI REPORT ===');
        console.log(`   Conversas: ${r.overview.totalConversations}  |  Mensagens: ${r.overview.totalMessages}`);
        console.log(`   Agendamentos: ${r.overview.totalAppointments}  |  Escalações: ${r.overview.totalEscalations}`);
        console.log(`   Tempo médio IA: ${r.averages.avgResponseTimeMs}ms  (p95: ${r.averages.p95ResponseTimeMs}ms)`);
        console.log(`   Conversão: ${r.rates.conversionRate}  |  Escalação: ${r.rates.escalationRate}  |  Satisfação: ${r.rates.estimatedSatisfaction}`);
        console.log(`   Msgs/conversa: ${r.averages.avgMessagesPerConversation}`);
        console.log('====================\n');
    }
}

module.exports = new KPITracker();
