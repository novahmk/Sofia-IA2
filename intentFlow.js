/**
 * Intent Flow Tracker
 * Rastreia a jornada de intenções de cada cliente ao longo da conversa.
 * Permite visualizar os caminhos mais comuns e pontos de abandono.
 */

class IntentFlowTracker {
    constructor() {
        // Fluxo de intenções por telefone: { "5511...": ["greeting", "pricing", "scheduling", ...] }
        this.flows = {};
        // Contadores de transições: { "greeting→pricing": 42, "pricing→scheduling": 18 }
        this.transitions = {};
        // Contadores de intenção final (última intenção antes de parar)
        this.exitIntents = {};
        // Funil: quantos chegaram a cada estágio
        this.funnelCounts = { greeting: 0, info_seeking: 0, pricing: 0, objection: 0, scheduling: 0, booked: 0, escalation: 0 };
    }

    /**
     * Classifica a intenção de uma mensagem do usuário
     */
    classifyIntent(userMessage) {
        const msg = userMessage.toLowerCase();

        // Saudação
        if (/^(oi|olá|ola|hey|eai|e aí|bom dia|boa tarde|boa noite|opa|fala|tudo bem|tudo certo)\b/i.test(msg.trim())) {
            return 'greeting';
        }

        // Agendamento
        if (/agend|marc|horár|disponív|consulta|visita|reserv/i.test(msg)) {
            return 'scheduling';
        }

        // Preço / custo
        if (/pre[çc]o|cust[oa]|valor|quanto|pag|parcel|financ|desc|invest/i.test(msg)) {
            return 'pricing';
        }

        // Objeção
        if (/caro|pensar|pesquis|n[aã]o sei|depois|talvez|medo|dói|dor/i.test(msg)) {
            return 'objection';
        }

        // Escalação
        if (/humano|atendente|gerente|pessoa|falar com|transfere/i.test(msg)) {
            return 'escalation';
        }

        // Confirmação / positivo
        if (/^(sim|ok|pode|bora|vamos|quero|claro|show|beleza|top|perfeito)\b/i.test(msg.trim())) {
            return 'confirmation';
        }

        // Informação técnica
        if (/transplant|fue|dhi|capilar|calvic|alopec|cabelo|fio|enxert|cirurgia|procedimento|técnica|resultado/i.test(msg)) {
            return 'info_seeking';
        }

        // Localização / logística
        if (/onde|endere|local|cidade|estado|ir até|chegar|região/i.test(msg)) {
            return 'logistics';
        }

        // Pós-operatório
        if (/pós|recupera|cuidad|após|dói|efeito|risco/i.test(msg)) {
            return 'post_op';
        }

        return 'general';
    }

    /**
     * Registra a intenção de uma mensagem no fluxo do usuário
     */
    recordIntent(phone, userMessage) {
        const intent = this.classifyIntent(userMessage);

        if (!this.flows[phone]) {
            this.flows[phone] = [];
        }

        const flow = this.flows[phone];
        const previousIntent = flow.length > 0 ? flow[flow.length - 1] : null;

        // Registrar transição (de → para)
        if (previousIntent && previousIntent !== intent) {
            const key = `${previousIntent}→${intent}`;
            this.transitions[key] = (this.transitions[key] || 0) + 1;
        }

        flow.push(intent);

        // Contagem no funil
        if (this.funnelCounts[intent] !== undefined) {
            this.funnelCounts[intent]++;
        }

        // Limitar tamanho (últimas 50 por user)
        if (flow.length > 50) {
            this.flows[phone] = flow.slice(-50);
        }

        return intent;
    }

    /**
     * Registra que o usuário "saiu" (timeout ou encerrou)
     */
    recordExit(phone) {
        const flow = this.flows[phone];
        if (flow && flow.length > 0) {
            const lastIntent = flow[flow.length - 1];
            this.exitIntents[lastIntent] = (this.exitIntents[lastIntent] || 0) + 1;
        }
    }

    /**
     * Registra conversão (agendamento)
     */
    recordConversion(phone) {
        if (!this.flows[phone]) return;
        this.flows[phone].push('booked');
        this.funnelCounts.booked++;
    }

    /**
     * Retorna o fluxo de intenções de um usuário
     */
    getFlow(phone) {
        return this.flows[phone] || [];
    }

    /**
     * Retorna as transições mais frequentes (top N)
     */
    getTopTransitions(n = 15) {
        return Object.entries(this.transitions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([transition, count]) => ({ transition, count }));
    }

    /**
     * Retorna relatório completo
     */
    getReport() {
        const totalFlows = Object.keys(this.flows).length;
        const avgFlowLength = totalFlows > 0
            ? +(Object.values(this.flows).reduce((sum, f) => sum + f.length, 0) / totalFlows).toFixed(1)
            : 0;

        // Calcular % de cada intent
        const totalIntents = Object.values(this.funnelCounts).reduce((a, b) => a + b, 0);
        const funnelPercentages = {};
        for (const [stage, count] of Object.entries(this.funnelCounts)) {
            funnelPercentages[stage] = totalIntents > 0
                ? `${((count / totalIntents) * 100).toFixed(1)}%`
                : '0%';
        }

        return {
            totalTrackedUsers: totalFlows,
            avgFlowLength,
            funnel: this.funnelCounts,
            funnelPercentages,
            topTransitions: this.getTopTransitions(10),
            exitIntents: this.exitIntents,
            commonPaths: this._getCommonPaths()
        };
    }

    /**
     * Identifica os 5 caminhos mais comuns (sequências de 3 intents)
     */
    _getCommonPaths() {
        const pathCounts = {};

        for (const flow of Object.values(this.flows)) {
            for (let i = 0; i <= flow.length - 3; i++) {
                const path = `${flow[i]}→${flow[i + 1]}→${flow[i + 2]}`;
                pathCounts[path] = (pathCounts[path] || 0) + 1;
            }
        }

        return Object.entries(pathCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([path, count]) => ({ path, count }));
    }
}

module.exports = new IntentFlowTracker();
