/**
 * analytics-api.js — Comunicação com a API Sofia IA2
 * Faz requisições autenticadas aos endpoints do servidor principal
 * e retorna dados normalizados para o dashboard analítico.
 */

'use strict';

const https = require('https');
const http  = require('http');

const SOFIA_API_BASE = process.env.SOFIA_API_URL || 'https://sofia-ia2-production.up.railway.app';
const SOFIA_JWT      = process.env.ANALYTICS_JWT_TOKEN || process.env.JWT_SECRET || '';

// Timeout padrão para requisições à API (ms)
const REQUEST_TIMEOUT = 12000;

// ─────────────────────────────────────────────────────────────
// UTILITÁRIO HTTP
// ─────────────────────────────────────────────────────────────

/**
 * Faz uma requisição HTTP/HTTPS e retorna { ok, status, body, latencyMs }.
 */
function request(urlStr, options = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        let url;
        try {
            url = new URL(urlStr);
        } catch (e) {
            return resolve({ ok: false, status: 0, body: null, latencyMs: 0, error: 'URL inválida' });
        }

        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const reqOptions = {
            hostname: url.hostname,
            port:     url.port || (isHttps ? 443 : 80),
            path:     url.pathname + url.search,
            method:   options.method || 'GET',
            headers:  {
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                'User-Agent':    'SofiaAnalyticsDashboard/1.0',
                ...(SOFIA_JWT ? { 'Authorization': `Bearer ${SOFIA_JWT}` } : {}),
                ...(options.headers || {}),
            },
        };

        const req = lib.request(reqOptions, (res) => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                const latencyMs = Date.now() - start;
                let body = null;
                try { body = JSON.parse(raw); } catch (e) { body = raw; }
                resolve({
                    ok:        res.statusCode >= 200 && res.statusCode < 400,
                    status:    res.statusCode,
                    body,
                    latencyMs,
                });
            });
        });

        req.on('error', (err) => {
            resolve({ ok: false, status: 0, body: null, latencyMs: Date.now() - start, error: err.message });
        });

        req.setTimeout(REQUEST_TIMEOUT, () => {
            req.destroy();
            resolve({ ok: false, status: 0, body: null, latencyMs: REQUEST_TIMEOUT, error: 'Timeout' });
        });

        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
    });
}

// ─────────────────────────────────────────────────────────────
// ENDPOINTS DA SOFIA IA2
// ─────────────────────────────────────────────────────────────

/**
 * GET /metrics — Métricas gerais (endpoint público)
 */
async function fetchMetrics() {
    const res = await request(`${SOFIA_API_BASE}/metrics`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

/**
 * GET /health — Health check do servidor principal
 */
async function fetchHealth() {
    const res = await request(`${SOFIA_API_BASE}/health`);
    return {
        ok:        res.ok,
        status:    res.status,
        latencyMs: res.latencyMs,
        body:      res.body,
        error:     res.error,
    };
}

/**
 * GET /api/dashboard/overview — KPIs, funil, volume por hora
 */
async function fetchOverview() {
    const res = await request(`${SOFIA_API_BASE}/api/dashboard/overview`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

/**
 * GET /api/dashboard/kpis — Latência, tokens, sentimento
 */
async function fetchKpis() {
    const res = await request(`${SOFIA_API_BASE}/api/dashboard/kpis`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

/**
 * GET /api/dashboard/conversations — Conversas ativas + histórico
 */
async function fetchConversations() {
    const res = await request(`${SOFIA_API_BASE}/api/dashboard/conversations`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

/**
 * GET /api/dashboard/leads — Leads com perfil e sentimento
 */
async function fetchLeads() {
    const res = await request(`${SOFIA_API_BASE}/api/dashboard/leads`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

/**
 * GET /api/dashboard/appointments — Agendamentos do dia
 */
async function fetchAppointments() {
    const res = await request(`${SOFIA_API_BASE}/api/dashboard/appointments`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

/**
 * GET /api/dashboard/system — Circuit breakers, self-healing
 */
async function fetchSystem() {
    const res = await request(`${SOFIA_API_BASE}/api/dashboard/system`);
    if (!res.ok) return { error: res.error || `HTTP ${res.status}`, latencyMs: res.latencyMs };
    return { ...res.body, latencyMs: res.latencyMs };
}

// ─────────────────────────────────────────────────────────────
// COLETA CONSOLIDADA (chamada a cada 10s)
// ─────────────────────────────────────────────────────────────

/**
 * Coleta todas as métricas em paralelo e retorna snapshot consolidado.
 * Tolerante a falhas: cada endpoint falha de forma independente.
 */
async function collectSnapshot() {
    const startedAt = Date.now();

    const [health, metrics, overview, kpis, conversations, leads, appointments, system] = await Promise.all([
        fetchHealth().catch(e => ({ error: e.message })),
        fetchMetrics().catch(e => ({ error: e.message })),
        fetchOverview().catch(e => ({ error: e.message })),
        fetchKpis().catch(e => ({ error: e.message })),
        fetchConversations().catch(e => ({ error: e.message })),
        fetchLeads().catch(e => ({ error: e.message })),
        fetchAppointments().catch(e => ({ error: e.message })),
        fetchSystem().catch(e => ({ error: e.message })),
    ]);

    // Normaliza métricas principais para o snapshot
    const overview_data = overview?.overview || overview || {};
    const kpis_data     = kpis?.kpis || kpis || {};
    const metrics_data  = metrics || {};

    const snapshot = {
        collectedAt:    new Date().toISOString(),
        collectionMs:   Date.now() - startedAt,
        apiReachable:   health.ok === true,
        apiLatencyMs:   health.latencyMs || 0,

        overview: {
            totalConversations:  overview_data.totalConversations  || metrics_data.overview?.totalConversations  || 0,
            totalMessages:       overview_data.totalMessages        || metrics_data.overview?.totalMessages        || 0,
            totalAppointments:   overview_data.totalAppointments    || metrics_data.overview?.totalAppointments    || 0,
            totalEscalations:    overview_data.totalEscalations     || metrics_data.overview?.totalEscalations     || 0,
            activeSessions:      overview_data.activeSessions       || metrics_data.activeSessions                 || 0,
            avgResponseTimeMs:   overview_data.avgResponseTimeMs    || metrics_data.averages?.avgResponseTimeMs    || 0,
            conversionRate:      overview_data.conversionRate       || metrics_data.rates?.conversionRate          || '0%',
            escalationRate:      overview_data.escalationRate       || metrics_data.rates?.escalationRate          || '0%',
            errorRate:           system?.performance?.errorRate     || 0,
            escalations:         overview_data.totalEscalations     || 0,
        },

        funnel: overview_data.funnel || metrics_data.funnel || {
            awareness: 0, consideration: 0, decision: 0, customer: 0,
        },

        sentiment: overview_data.sentiment || metrics_data.sentiment || {
            positive: 0, neutral: 0, negative: 0,
        },

        hourlyVolume: overview_data.hourlyVolume || metrics_data.hourlyVolume || {},

        kpis: {
            avgLatencyMs:    kpis_data.avgLatencyMs    || overview_data.avgResponseTimeMs || 0,
            p95LatencyMs:    kpis_data.p95LatencyMs    || metrics_data.averages?.p95ResponseTimeMs || 0,
            satisfaction:    kpis_data.satisfaction    || metrics_data.rates?.estimatedSatisfaction || 'N/A',
            tokensUsed:      kpis_data.tokensUsed      || 0,
            uptime:          kpis_data.uptime          || system?.performance?.uptime || 0,
        },

        conversations: {
            active:  Array.isArray(conversations?.conversations)
                ? conversations.conversations.filter(c => c.status === 'active').length
                : (conversations?.activeConversations || 0),
            manual:  conversations?.manualConversations || 0,
            list:    (conversations?.conversations || []).slice(0, 20),
        },

        leads: {
            total: Array.isArray(leads?.clients) ? leads.clients.length : (leads?.total || 0),
            list:  (leads?.clients || leads?.leads || []).slice(0, 20),
        },

        appointments: {
            today:     Array.isArray(appointments?.appointments) ? appointments.appointments.length : 0,
            confirmed: Array.isArray(appointments?.appointments)
                ? appointments.appointments.filter(a => a.status === 'confirmed').length
                : 0,
            list:      (appointments?.appointments || []).slice(0, 10),
        },

        system: {
            uptime:        system?.performance?.uptime || 0,
            totalErrors:   system?.performance?.totalErrors || 0,
            errorRate:     system?.performance?.errorRate || 0,
            selfHealing:   system?.selfHealing || {},
            circuitBreakers: system?.circuitBreakers || {},
        },

        rawMetrics: metrics_data,
    };

    return snapshot;
}

module.exports = {
    fetchMetrics,
    fetchHealth,
    fetchOverview,
    fetchKpis,
    fetchConversations,
    fetchLeads,
    fetchAppointments,
    fetchSystem,
    collectSnapshot,
};
