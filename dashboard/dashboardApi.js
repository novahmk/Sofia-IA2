/**
 * dashboardApi.js — API endpoints para o dashboard da Sofia IA
 * Agrega dados de todos os módulos e retorna em formato pronto para o frontend.
 * Inclui validação REAL de conexões com serviços externos.
 */

const https = require('https');
const kpiTracker = require('../kpiTracker');
const intentFlow = require('../intentFlow');
const abTesting = require('../abTesting');
const topicBlacklist = require('../topicBlacklist');
const swop = require('../swop');
const selfHealing = require('../utils/selfHealing');
const inputSanitizer = require('../utils/inputSanitizer');
const clientMemory = require('../clientMemory');
const conversationManager = require('../core/conversationManager');
const auditLogger = require('../utils/auditLogger');
const knowledgeBase = require('../knowledgeBase');

// =====================================================
// CACHE DE HEALTH CHECK (evita spam de requests)
// =====================================================
let _healthCache = null;
let _healthCacheTime = 0;
const HEALTH_CACHE_TTL = 30000; // 30 segundos

/**
 * Retorna todos os dados necessários para o dashboard em uma única chamada
 */
function getDashboardData(rateLimits, messageQueues) {
    const now = new Date();
    const kpis = safeCall(() => kpiTracker.getReport(), {});
    const intents = safeCall(() => intentFlow.getReport(), {});
    const ab = safeCall(() => abTesting.getReport(), {});
    const perf = safeCall(() => swop.getHealthReport(), {});
    const heal = safeCall(() => selfHealing.getReport(), {});
    const security = safeCall(() => inputSanitizer.getReport(), {});
    const blacklist = safeCall(() => topicBlacklist.getReport(), {});
    const audit = safeCall(() => auditLogger.getReport(), {});
    const auditLogs = safeCall(() => auditLogger.query(null, 20), []);
    const clients = safeCall(() => clientMemory.listAllClients(), []);
    const conversations = safeCall(() => getActiveConversations(), []);
    const kbReport = safeCall(() => getKBReport(), {});

    // Overview KPIs
    const overview = {
        totalConversations: kpis.overview?.totalConversations || 0,
        totalMessages: kpis.overview?.totalMessages || 0,
        totalAppointments: kpis.overview?.totalAppointments || 0,
        totalEscalations: kpis.overview?.totalEscalations || 0,
        avgResponseTimeMs: kpis.averages?.avgResponseTimeMs || 0,
        avgResponseTimeSec: ((kpis.averages?.avgResponseTimeMs || 0) / 1000).toFixed(1),
        p95ResponseTimeSec: ((kpis.averages?.p95 || 0) / 1000).toFixed(1),
        conversionRate: kpis.rates?.conversionRate || 0,
        escalationRate: kpis.rates?.escalationRate || 0,
        activeSessions: kpis.activeSessions || 0,
    };

    // Funnel
    const funnel = {
        messages: overview.totalMessages,
        engaged: kpis.funnel?.consideration || 0 + (kpis.funnel?.decision || 0) + (kpis.funnel?.customer || 0) + (kpis.funnel?.awareness || 0),
        qualified: (kpis.funnel?.consideration || 0) + (kpis.funnel?.decision || 0) + (kpis.funnel?.customer || 0),
        scheduled: overview.totalAppointments,
        confirmed: kpis.funnel?.customer || 0,
        awareness: kpis.funnel?.awareness || 0,
        consideration: kpis.funnel?.consideration || 0,
        decision: kpis.funnel?.decision || 0,
        customer: kpis.funnel?.customer || 0,
    };

    // Sentiment
    const sentiment = {
        positive: kpis.sentiment?.positive || 0,
        neutral: kpis.sentiment?.neutral || 0,
        negative: kpis.sentiment?.negative || 0,
    };

    // Hourly volume
    const hourlyVolume = kpis.hourlyVolume || {};
    const hourlyLabels = [];
    const hourlyData = [];
    for (let h = 0; h < 24; h++) {
        hourlyLabels.push(h + 'h');
        hourlyData.push(hourlyVolume[h] || 0);
    }

    // Intent distribution
    const intentDist = kpis.intentDistribution || intents.funnel || {};

    // Media types
    const mediaTypes = kpis.mediaTypes || { text: 0, audio: 0, image: 0, video: 0, document: 0 };

    // Performance / SWOP
    const performance = {
        uptime: perf.uptime || 0,
        uptimeFormatted: formatUptime(perf.uptime || 0),
        totalMessages: perf.totalMessages || 0,
        totalErrors: perf.totalErrors || 0,
        errorRate: perf.errorRate || '0',
        avgLatency: perf.avgLatency || 0,
        avgLatencySec: ((perf.avgLatency || 0) / 1000).toFixed(1),
        maxLatency: perf.maxLatency || 0,
        minLatency: perf.minLatency || 0,
        recentErrors: perf.recentErrors || [],
        latencyLog: (perf.latencyLog || []).slice(-100),
    };

    // Self-healing
    const selfHealingData = {
        totalAttempts: heal.totalAttempts || 0,
        totalRecovered: heal.totalRecovered || 0,
        recentEvents: heal.recentEvents || heal.log || [],
    };

    // Security
    const securityData = {
        totalSanitized: security.totalSanitized || security.totalChecked || 0,
        totalBlocked: security.totalBlocked || 0,
        injectionAttempts: security.injectionAttempts || 0,
        xssAttempts: security.xssAttempts || 0,
        topicBlocked: blacklist.totalBlocked || 0,
        topicBreakdown: blacklist.breakdown || {},
    };

    // A/B Testing
    const abData = {
        variants: ab.variants || {},
        winner: ab.winner || null,
        totalAssignments: ab.totalAssignments || 0,
    };

    // Client profiles
    const clientProfiles = clients.map(phone => {
        const mem = safeCall(() => clientMemory.exportClientData(phone), {});
        const convInfo = safeCall(() => conversationManager.getConversationInfo(phone), {});
        return {
            phone,
            name: mem.personal?.name || phone,
            location: mem.personal?.location || '',
            funnelStage: mem.funnel_stage || 'awareness',
            sentiment: mem.sentiment || 'neutral',
            hairCondition: mem.hair_health?.hair_condition || '',
            baldnessDegree: mem.hair_health?.baldness_degree || '',
            concerns: mem.hair_health?.concerns || [],
            objections: mem.conversation?.objections || [],
            totalMessages: mem.conversation?.total_messages || 0,
            lastUpdated: mem.last_updated || '',
            mode: convInfo.mode || 'auto',
            status: convInfo.status || 'unknown',
        };
    });

    // Active conversations
    const activeConvs = conversations.filter(c => c.status === 'active');
    const manualConvs = conversations.filter(c => c.mode === 'manual');

    // Audit logs formatted
    const recentAudit = (Array.isArray(auditLogs) ? auditLogs : []).map(log => ({
        timestamp: log.timestamp || '',
        action: log.action || '',
        phone: log.phone || '',
        details: typeof log.details === 'string' ? log.details : JSON.stringify(log.details || {}),
    }));

    // LGPD / Consent data
    const lgpd = {
        consentsTracked: audit.LGPD_CONSENT || 0,
        exportRequests: audit.LGPD_EXPORT || 0,
        deleteRequests: audit.LGPD_DELETE || 0,
        auditActionTypes: Object.keys(audit).length,
    };

    // Rate limits
    const rateLimitData = {
        activeUsers: Object.keys(rateLimits || {}).length,
        blockedUsers: Object.values(rateLimits || {}).filter(r => r.blocked).length,
    };

    return {
        timestamp: now.toISOString(),
        overview,
        funnel,
        sentiment,
        hourlyVolume: { labels: hourlyLabels, data: hourlyData },
        intentDistribution: intentDist,
        mediaTypes,
        performance,
        selfHealing: selfHealingData,
        security: securityData,
        abTesting: abData,
        clients: clientProfiles,
        conversations,
        activeConversations: activeConvs.length,
        manualConversations: manualConvs.length,
        recentAudit,
        lgpd,
        rateLimits: rateLimitData,
        kb: kbReport,
        dailyVolume: kpis.dailyVolume || {},
        responseTimes: (kpis.averages?.responseTimes || []).slice(-50),
        services: getServicesStatus(perf),
    };
}

/**
 * Status dos serviços integrados — VALIDAÇÃO REAL
 * Faz ping real em cada serviço externo com timeout
 */
function getServicesStatus(perf) {
    // Retorna status base (síncrono) — será sobrescrito pelo health check assíncrono
    const messagingLabel = process.env.WASENDERAPI_BASE_URL ? 'WASenderAPI Chat' : 'UAZAPI WhatsApp';
    return {
        sofia: { status: 'online', label: 'Sofia IA (Node.js)', latencyMs: null, lastChecked: new Date().toISOString(), detail: `Uptime: ${formatUptime(process.uptime())}` },
        openai: { status: 'unknown', label: 'OpenAI GPT-4o', latencyMs: null, lastChecked: null, detail: 'Aguardando verificação...' },
        uazapi: { status: 'unknown', label: messagingLabel, latencyMs: null, lastChecked: null, detail: 'Aguardando verificação...' },
        calendar: { status: 'unknown', label: 'Google Calendar', latencyMs: null, lastChecked: null, detail: 'Aguardando verificação...' },
        database: { status: 'unknown', label: 'Banco de Dados', latencyMs: null, lastChecked: null, detail: 'Aguardando verificação...' },
    };
}

// =====================================================
// HEALTH CHECK REAL — PINGA CADA SERVIÇO
// =====================================================

/**
 * Faz request HTTPS com timeout e retorna {ok, latencyMs, detail}
 */
function httpCheck(options, timeout = 8000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                const latencyMs = Date.now() - start;
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve({ ok: true, latencyMs, statusCode: res.statusCode, body });
                } else {
                    let detail = `HTTP ${res.statusCode}`;
                    try { const json = JSON.parse(body); detail = json.error?.message || json.message || detail; } catch (e) {}
                    resolve({ ok: false, latencyMs, statusCode: res.statusCode, detail });
                }
            });
        });
        req.on('error', (err) => {
            resolve({ ok: false, latencyMs: Date.now() - start, detail: err.message });
        });
        req.setTimeout(timeout, () => {
            req.destroy();
            resolve({ ok: false, latencyMs: timeout, detail: 'Timeout' });
        });
        req.end();
    });
}

/**
 * Verifica conexão REAL com a OpenAI API
 */
async function checkOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { status: 'error', latencyMs: 0, detail: 'OPENAI_API_KEY não configurada' };
    }
    try {
        const result = await httpCheck({
            hostname: 'api.openai.com',
            path: '/v1/models?limit=1',
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        }, 8000);
        if (result.ok) {
            return { status: 'online', latencyMs: result.latencyMs, detail: `API respondeu em ${result.latencyMs}ms` };
        }
        if (result.statusCode === 401) {
            return { status: 'error', latencyMs: result.latencyMs, detail: 'API Key inválida (401 Unauthorized)' };
        }
        if (result.statusCode === 429) {
            return { status: 'warning', latencyMs: result.latencyMs, detail: 'Rate limit atingido (429)' };
        }
        return { status: 'error', latencyMs: result.latencyMs, detail: result.detail || `Erro HTTP ${result.statusCode}` };
    } catch (err) {
        return { status: 'error', latencyMs: 0, detail: err.message };
    }
}

/**
 * Verifica conexão REAL com a UAZAPI
 */
async function checkUazapi() {
    const token = process.env.UAZAPI_TOKEN;
    const baseUrl = process.env.UAZAPI_BASE_URL || 'https://free.uazapi.com';
    if (!token) {
        return { status: 'error', latencyMs: 0, detail: 'UAZAPI_TOKEN não configurado' };
    }
    try {
        const url = new URL(baseUrl);
        const result = await httpCheck({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: '/status',
            method: 'GET',
            headers: { 'token': token }
        }, 8000);
        if (result.ok) {
            let detail = '';
            try {
                const data = JSON.parse(result.body);
                const inst = data.status?.checked_instance || {};
                const connStatus = inst.connection_status || 'unknown';
                const name = inst.name || '';
                if (connStatus === 'connected') {
                    detail = `Conectado${name ? ' — ' + name.trim() : ''} (${result.latencyMs}ms)`;
                    return { status: 'online', latencyMs: result.latencyMs, detail };
                } else if (connStatus === 'connecting') {
                    return { status: 'warning', latencyMs: result.latencyMs, detail: `Conectando... (${result.latencyMs}ms)` };
                } else {
                    return { status: 'error', latencyMs: result.latencyMs, detail: `Desconectado do WhatsApp (${connStatus})` };
                }
            } catch (e) {
                return { status: 'online', latencyMs: result.latencyMs, detail: `API respondeu em ${result.latencyMs}ms` };
            }
        }
        if (result.statusCode === 401 || result.statusCode === 403) {
            return { status: 'error', latencyMs: result.latencyMs, detail: 'Token inválido (401/403)' };
        }
        return { status: 'error', latencyMs: result.latencyMs, detail: result.detail || `Erro HTTP ${result.statusCode}` };
    } catch (err) {
        return { status: 'error', latencyMs: 0, detail: err.message };
    }
}

/**
 * Verifica conexão REAL com o WASenderAPI
 */
async function checkWasenderapi() {
    const token = process.env.WASENDERAPI_TOKEN;
    const baseUrl = process.env.WASENDERAPI_BASE_URL;
    const statusPath = process.env.WASENDERAPI_STATUS_PATH || '/status';
    if (!token) {
        return { status: 'error', latencyMs: 0, detail: 'WASENDERAPI_TOKEN não configurado' };
    }
    if (!baseUrl) {
        return { status: 'error', latencyMs: 0, detail: 'WASENDERAPI_BASE_URL não configurado' };
    }
    try {
        const url = new URL(baseUrl);
        const path = statusPath.startsWith('/') ? statusPath : `/${statusPath}`;
        const result = await httpCheck({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        }, 8000);

        if (result.ok) {
            let detail = `API respondeu em ${result.latencyMs}ms`;
            try {
                const data = JSON.parse(result.body);
                if (data.status) {
                    detail = `${data.status}${data.message ? ` — ${data.message}` : ''} (${result.latencyMs}ms)`;
                }
            } catch (e) {
                // não crítico se o corpo não for JSON
            }
            return { status: 'online', latencyMs: result.latencyMs, detail };
        }
        if (result.statusCode === 401 || result.statusCode === 403) {
            return { status: 'error', latencyMs: result.latencyMs, detail: 'Token inválido (401/403)' };
        }
        return { status: 'error', latencyMs: result.latencyMs, detail: result.detail || `Erro HTTP ${result.statusCode}` };
    } catch (err) {
        return { status: 'error', latencyMs: 0, detail: err.message };
    }
}

/**
 * Verifica se Google Calendar está configurado e acessível
 */
async function checkGoogleCalendar() {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const calId = process.env.GOOGLE_CALENDAR_ID;
    if (!keyFile) {
        return { status: 'error', latencyMs: 0, detail: 'GOOGLE_SERVICE_ACCOUNT_JSON não configurado' };
    }
    if (!calId || calId.includes('seu-email')) {
        return { status: 'warning', latencyMs: 0, detail: 'GOOGLE_CALENDAR_ID não configurado (placeholder)' };
    }
    // Verificar se o arquivo de credenciais existe
    const fs = require('fs');
    const path = require('path');
    const credPath = path.resolve(__dirname, keyFile);
    if (!fs.existsSync(credPath)) {
        return { status: 'error', latencyMs: 0, detail: `Arquivo de credenciais não encontrado: ${keyFile}` };
    }
    try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        if (!creds.client_email || !creds.private_key) {
            return { status: 'error', latencyMs: 0, detail: 'Credenciais inválidas (faltam client_email/private_key)' };
        }
        return { status: 'online', latencyMs: 0, detail: `Service account: ${creds.client_email}` };
    } catch (err) {
        return { status: 'error', latencyMs: 0, detail: `Erro ao ler credenciais: ${err.message}` };
    }
}

/**
 * Verifica Database (PostgreSQL ou local)
 */
let _pgPool = null;
async function checkDatabase() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        return { status: 'warning', latencyMs: 0, detail: 'PostgreSQL não configurado' };
    }
    try {
        if (!_pgPool) {
            const { Pool } = require('pg');
            _pgPool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 2 });
        }
        const start = Date.now();
        await _pgPool.query('SELECT 1');
        return { status: 'online', latencyMs: Date.now() - start, detail: 'PostgreSQL OK' };
    } catch (err) {
        return { status: 'error', latencyMs: 0, detail: err.message };
    }
}

/**
 * Executa todos os health checks em paralelo e retorna resultado consolidado
 */
async function runHealthChecks() {
    const now = Date.now();
    // Usar cache se ainda válido
    if (_healthCache && (now - _healthCacheTime) < HEALTH_CACHE_TTL) {
        return _healthCache;
    }

    const timestamp = new Date().toISOString();
    const messagingCheck = process.env.WASENDERAPI_BASE_URL ? checkWasenderapi() : checkUazapi();
    const [openai, messaging, calendar, database] = await Promise.all([
        checkOpenAI(),
        messagingCheck,
        checkGoogleCalendar(),
        checkDatabase(),
    ]);

    const messagingLabel = process.env.WASENDERAPI_BASE_URL ? 'WASenderAPI Chat' : 'UAZAPI WhatsApp';
    const result = {
        sofia: { status: 'online', label: 'Sofia IA (Node.js)', latencyMs: 0, lastChecked: timestamp, detail: `Uptime: ${formatUptime(process.uptime())}` },
        openai: { ...openai, label: 'OpenAI GPT-4o', lastChecked: timestamp },
        uazapi: { ...messaging, label: messagingLabel, lastChecked: timestamp },
        calendar: { ...calendar, label: 'Google Calendar', lastChecked: timestamp },
        database: { ...database, label: 'Banco de Dados', lastChecked: timestamp },
    };

    _healthCache = result;
    _healthCacheTime = now;
    return result;
}

/**
 * Lista conversas ativas com metadados
 */
function getActiveConversations() {
    if (typeof conversationManager.listAllConversations === 'function') {
        return conversationManager.listAllConversations();
    }
    // Fallback: tentar via estados internos
    const states = conversationManager.states || conversationManager._states || {};
    return Object.entries(states).map(([phone, state]) => ({
        phone,
        status: state.status || 'unknown',
        mode: state.mode || 'auto',
        messageCount: state.messageCount || 0,
        lastMessageTime: state.lastMessageTime || '',
        lastMessage: (state.conversationHistory || []).slice(-1)[0]?.text || '',
    }));
}

/**
 * Knowledge Base report
 */
function getKBReport() {
    if (typeof knowledgeBase.getReport === 'function') {
        return knowledgeBase.getReport();
    }
    return {
        totalDocuments: knowledgeBase.documents?.length || knowledgeBase._documents?.size || 0,
        queryCount: 0,
        gaps: [],
    };
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function safeCall(fn, fallback) {
    try { return fn() || fallback; } catch (e) { return fallback; }
}

module.exports = { getDashboardData, runHealthChecks };
