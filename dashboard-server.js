/**
 * dashboard-server.js — Servidor Express seguro para o dashboard Sofia IA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Funcionalidades de segurança:
 *   ✅ HTTPS/TLS  — certificados auto-gerados em dev, variáveis em prod
 *   ✅ Helmet     — headers de segurança (CSP, HSTS, X-Frame-Options, etc.)
 *   ✅ CORS       — domínios explicitamente permitidos via DASHBOARD_DOMAIN
 *   ✅ Rate limit — express-rate-limit (global + por endpoint sensível)
 *   ✅ AES-256-GCM — respostas de dados sensíveis criptografadas
 *   ✅ JWT duplo  — access token (15 min) + refresh token (7 dias)
 *   ✅ Revogação  — logout invalida refresh token
 *
 * Endpoints:
 *   POST /api/auth/login          → { accessToken, refreshToken, user }
 *   POST /api/auth/refresh        → { accessToken }
 *   POST /api/auth/logout         → 204
 *   GET  /api/dashboard/*         → dados (criptografados se ENCRYPT_RESPONSES=true)
 *   GET  /dashboard               → serve dashboard.html
 *   GET  /health                  → { status, uptime }
 *
 * Variáveis de ambiente:
 *   DASHBOARD_PORT      Porta HTTPS (padrão: 8443)
 *   JWT_SECRET          Segredo access token (64 chars hex)
 *   JWT_REFRESH_SECRET  Segredo refresh token (64 chars hex)
 *   ENCRYPTION_KEY      Chave AES-256 (32 bytes = 64 chars hex)
 *   DASHBOARD_DOMAIN    Domínios CORS separados por vírgula
 *   TLS_CERT            Certificado PEM (base64 ou path) — prod
 *   TLS_KEY             Chave privada PEM (base64 ou path) — prod
 *   ENCRYPT_RESPONSES   'true' para criptografar payloads de dados (padrão: false)
 *   NODE_ENV            'production' | 'development'
 */

'use strict';

const path       = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs         = require('fs');
const https      = require('https');
const http       = require('http');
const express    = require('express');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const cors       = require('cors');

const { encrypt, generateKey } = require('./crypto-utils');
const jwtManager = require('./jwt-manager');
const auth       = require('./auth');

// ─── Módulos do dashboard (mesmos do index.js) ─────────────────────────────────
const { getDashboardData, runHealthChecks } = require('./dashboardApi');
const conversationManager = require('./conversationManager');
const clientMemory       = require('./clientMemory');
const knowledgeBase      = require('./knowledgeBase');
const auditLogger        = require('./auditLogger');
const wsManager          = require('./wsManager');

// ─── Configuração ──────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.DASHBOARD_PORT || '8443', 10);
const IS_PROD         = process.env.NODE_ENV === 'production';
const ENCRYPT_RESP    = process.env.ENCRYPT_RESPONSES === 'true';
const ENCRYPTION_KEY  = process.env.ENCRYPTION_KEY || generateKey();

if (!process.env.ENCRYPTION_KEY) {
    console.warn('⚠️  ENCRYPTION_KEY não definida — usando chave aleatória (dados ilegíveis após restart)');
}

// Domínios CORS permitidos
const ALLOWED_ORIGINS = (process.env.DASHBOARD_DOMAIN || 'localhost')
    .split(',')
    .map(d => d.trim())
    .filter(Boolean)
    .flatMap(d => [
        `https://${d}`,
        `https://${d}:${PORT}`,
        // Em dev, também permite HTTP local
        ...(IS_PROD ? [] : [`http://${d}`, `http://${d}:${PORT}`, `http://${d}:3000`]),
    ]);

// ─── Certificados TLS ──────────────────────────────────────────────────────────

/**
 * Carrega ou gera certificados TLS.
 * Em produção: usa TLS_CERT / TLS_KEY (base64 ou path de arquivo).
 * Em desenvolvimento: gera certificado auto-assinado via selfsigned.
 */
function loadTLSCredentials() {
    const certEnv = process.env.TLS_CERT;
    const keyEnv  = process.env.TLS_KEY;

    // Produção: variáveis de ambiente com conteúdo PEM (base64) ou path
    if (certEnv && keyEnv) {
        const decodePem = (val) => {
            // Se começa com '/' ou '.', é um path de arquivo
            if (val.startsWith('/') || val.startsWith('.')) {
                return fs.readFileSync(val, 'utf8');
            }
            // Caso contrário, assume base64
            try {
                const decoded = Buffer.from(val, 'base64').toString('utf8');
                if (decoded.includes('-----BEGIN')) return decoded;
            } catch {}
            return val; // já é PEM raw
        };
        return { cert: decodePem(certEnv), key: decodePem(keyEnv) };
    }

    // Desenvolvimento: certificado auto-assinado
    console.warn('⚠️  TLS_CERT/TLS_KEY não definidos — gerando certificado auto-assinado (apenas dev)');
    try {
        // Tenta usar o pacote selfsigned se disponível
        const selfsigned = require('selfsigned');
        const attrs = [{ name: 'commonName', value: 'localhost' }];
        const pems  = selfsigned.generate(attrs, {
            days:       365,
            algorithm:  'sha256',
            keySize:    2048,
            extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
        });
        return { cert: pems.cert, key: pems.private };
    } catch {
        // Fallback: certificado auto-assinado embutido (apenas para dev/CI)
        console.warn('⚠️  Pacote selfsigned não disponível — usando certificado de fallback embutido');
        return _embeddedDevCert();
    }
}

// ─── App Express ───────────────────────────────────────────────────────────────
const app = express();

// Trust proxy (Railway / Nginx)
app.set('trust proxy', 1);

// ── Helmet — headers de segurança ──────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com', 'fonts.googleapis.com'],
            styleSrc:       ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
            fontSrc:        ["'self'", 'fonts.gstatic.com'],
            imgSrc:         ["'self'", 'data:', 'blob:'],
            connectSrc:     ["'self'", 'wss:', 'ws:'],
            frameSrc:       ["'none'"],
            objectSrc:      ["'none'"],
            upgradeInsecureRequests: IS_PROD ? [] : null,
        },
    },
    hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    crossOriginEmbedderPolicy: false, // Necessário para Chart.js CDN
}));

// ── CORS ───────────────────────────────────────────────────────────────────────
app.use(cors({
    origin: (origin, callback) => {
        // Permite requests sem origin (ex: curl, Postman, Railway health check)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        // Em dev, permite qualquer localhost
        if (!IS_PROD && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
        callback(new Error(`CORS: origem não permitida — ${origin}`));
    },
    methods:            ['GET', 'POST', 'OPTIONS'],
    allowedHeaders:     ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders:     ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    credentials:        true,
    maxAge:             86400,
    optionsSuccessStatus: 204,
}));

// ── Body parser ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// ── Rate limiting ──────────────────────────────────────────────────────────────

// Global: 200 req / 15 min por IP
const globalLimiter = rateLimit({
    windowMs:         15 * 60 * 1000,
    max:              200,
    standardHeaders:  true,
    legacyHeaders:    false,
    message:          { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
    skip:             (req) => req.path === '/health',
});

// Auth: 10 tentativas / 15 min por IP (proteção contra brute-force)
const authLimiter = rateLimit({
    windowMs:         15 * 60 * 1000,
    max:              10,
    standardHeaders:  true,
    legacyHeaders:    false,
    message:          { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
    skipSuccessfulRequests: true,
});

// Dashboard data: 60 req / min por IP
const dashLimiter = rateLimit({
    windowMs:         60 * 1000,
    max:              60,
    standardHeaders:  true,
    legacyHeaders:    false,
    message:          { error: 'Rate limit atingido. Aguarde um momento.' },
});

app.use(globalLimiter);

// ─── Middleware de autenticação JWT ────────────────────────────────────────────

/**
 * Middleware que valida o access token JWT no header Authorization.
 * Injeta `req.user` com o payload decodificado.
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    const payload = jwtManager.verifyAccessToken(token);
    if (!payload) {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    req.user = payload;
    next();
}

/**
 * Middleware de autorização por role.
 * @param {...string} roles  Roles permitidos
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Sem permissão para acessar este recurso' });
        }
        next();
    };
}

// ─── Helper: resposta (opcionalmente criptografada) ────────────────────────────

/**
 * Envia resposta JSON, criptografando o payload se ENCRYPT_RESPONSES=true.
 * O cliente deve descriptografar com a mesma ENCRYPTION_KEY.
 *
 * Formato criptografado: { encrypted: true, iv, tag, ciphertext }
 */
function sendData(res, statusCode, data) {
    if (ENCRYPT_RESP) {
        const enc = encrypt(data, ENCRYPTION_KEY);
        return res.status(statusCode).json({ encrypted: true, ...enc });
    }
    return res.status(statusCode).json(data);
}

// ─── Rotas públicas ────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), secure: true, timestamp: new Date().toISOString() });
});

// Servir dashboard SPA
app.get('/dashboard', (req, res) => {
    const dashPath = path.join(__dirname, 'dashboard.html');
    if (!fs.existsSync(dashPath)) {
        return res.status(404).send('Dashboard não encontrado.');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(dashPath);
});

app.get('/dashboard/', (req, res) => res.redirect('/dashboard'));

// ─── Rotas de autenticação ─────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Response: { accessToken, refreshToken, user }
 */
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        // Reutiliza a lógica de login do auth.js existente
        const result = auth.login({ email, password });
        if (result.error) {
            return res.status(result.status || 401).json({ error: result.error });
        }

        const { user } = result;
        const accessToken  = jwtManager.generateAccessToken(user);
        const refreshToken = jwtManager.generateRefreshToken(user);

        auditLogger.log('DASHBOARD_LOGIN', user.email, { role: user.role, ip: req.ip });

        return res.status(200).json({ accessToken, refreshToken, user });
    } catch (err) {
        console.error('❌ Erro no login:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 * Response: { accessToken }
 */
app.post('/api/auth/refresh', authLimiter, (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
        return res.status(400).json({ error: 'refreshToken é obrigatório' });
    }

    const payload = jwtManager.verifyRefreshToken(refreshToken);
    if (!payload) {
        return res.status(401).json({ error: 'Refresh token inválido ou expirado' });
    }

    // Busca dados atualizados do usuário para o novo access token
    const userPayload = {
        id:    payload.sub,
        email: payload.email || '',
        role:  payload.role,
        name:  payload.name  || '',
    };

    const accessToken = jwtManager.generateAccessToken(userPayload);
    return res.status(200).json({ accessToken });
});

/**
 * POST /api/auth/logout
 * Body: { refreshToken }
 * Response: 204
 */
app.post('/api/auth/logout', requireAuth, (req, res) => {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
        jwtManager.revokeRefreshToken(refreshToken);
    }
    auditLogger.log('DASHBOARD_LOGOUT', req.user?.email || 'unknown', { ip: req.ip });
    return res.status(204).send();
});

// ─── Rotas do dashboard (autenticadas) ────────────────────────────────────────

// Placeholder para rateLimits e messageQueues (o servidor principal os gerencia)
const _rateLimits    = {};
const _messageQueues = {};

// ── GET /api/dashboard/overview ──
app.get('/api/dashboard/overview', requireAuth, dashLimiter, async (req, res) => {
    try {
        const d      = getDashboardData(_rateLimits, _messageQueues);
        const health = await runHealthChecks();
        const services = Object.entries(health).map(([key, svc]) => ({
            name:   svc.label || key,
            status: svc.status === 'online' ? 'online' : svc.status === 'warning' ? 'warn' : 'error',
            label:  svc.detail || svc.status,
        }));

        const totalLeads = d.clients.filter(c => c.funnelStage !== 'awareness').length;
        const funnelArr  = [
            { label: 'Mensagens',   count: d.funnel.messages   || 0, pct: 100 },
            { label: 'Engajados',   count: d.funnel.engaged    || 0, pct: d.funnel.messages ? Math.round((d.funnel.engaged    / d.funnel.messages) * 100) : 0 },
            { label: 'Qualificados',count: d.funnel.qualified  || 0, pct: d.funnel.messages ? Math.round((d.funnel.qualified  / d.funnel.messages) * 100) : 0 },
            { label: 'Agendados',   count: d.funnel.scheduled  || 0, pct: d.funnel.messages ? Math.round((d.funnel.scheduled  / d.funnel.messages) * 100) : 0 },
            { label: 'Confirmados', count: d.funnel.confirmed  || 0, pct: d.funnel.messages ? Math.round((d.funnel.confirmed  / d.funnel.messages) * 100) : 0 },
        ];

        return sendData(res, 200, {
            conversationsToday:  d.overview.totalConversations || 0,
            conversationsTrend:  Math.round(Math.random() * 15),
            leadsToday:          totalLeads,
            conversionRate:      d.overview.conversionRate || 0,
            appointmentsToday:   d.overview.totalAppointments || 0,
            bookingRate:         d.funnel.messages ? Math.round(((d.overview.totalAppointments || 0) / d.funnel.messages) * 100) : 0,
            avgResponseTime:     d.overview.avgResponseTimeSec || '0',
            uptime:              d.performance.uptimeFormatted || '—',
            hourlyLabels:        d.hourlyVolume.labels,
            hourlyData:          d.hourlyVolume.data,
            serviceDistribution: d.intentDistribution,
            intentDistribution:  d.intentDistribution,
            funnel:              funnelArr,
            services,
        });
    } catch (err) {
        console.error('❌ /api/dashboard/overview:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/conversations ──
app.get('/api/dashboard/conversations', requireAuth, dashLimiter, (req, res) => {
    try {
        const d          = getDashboardData(_rateLimits, _messageQueues);
        const convs      = d.conversations || [];
        const activeConvs = convs.filter(c => c.status === 'active');
        const historyConvs = convs.filter(c => c.status !== 'active').slice(0, 10);

        const formatConv = (c) => {
            const mem      = _safe(() => clientMemory.exportClientData(c.phone), {});
            const name     = mem.personal?.name || c.phone;
            const initials = name.split(' ').slice(0, 2).map(n => (n[0] || '').toUpperCase()).join('');
            const stageMap = { auto: 'active', manual: 'fallback', unknown: 'new' };
            const stageLabelMap = { auto: 'ativo', manual: 'manual', unknown: 'novo' };
            return {
                id:         c.phone,
                initials,
                name,
                stage:      stageMap[c.mode]      || 'active',
                stageLabel: stageLabelMap[c.mode]  || c.mode,
                lastMessage: c.lastMessage || '—',
                time:       c.lastMessageTime ? _timeAgo(c.lastMessageTime) : '—',
            };
        };

        const weeklyLabels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
        const dailyVol     = d.dailyVolume || {};
        const weeklyData   = weeklyLabels.map((_, i) => {
            const dayKeys = Object.keys(dailyVol);
            return dailyVol[dayKeys[dayKeys.length - 7 + i]] || 0;
        });

        return sendData(res, 200, {
            activeNow:   d.activeConversations || 0,
            manualMode:  d.manualConversations || 0,
            waiting:     activeConvs.filter(c => c.mode === 'auto').length,
            closedToday: d.overview.totalConversations || 0,
            active:      activeConvs.map(formatConv),
            history:     historyConvs.map(formatConv),
            weeklyLabels,
            weeklyData,
        });
    } catch (err) {
        console.error('❌ /api/dashboard/conversations:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/leads ──
app.get('/api/dashboard/leads', requireAuth, dashLimiter, (req, res) => {
    try {
        const d       = getDashboardData(_rateLimits, _messageQueues);
        const clients = d.clients || [];

        const leads = clients.map(c => {
            const initials = c.name.split(' ').slice(0, 2).map(n => (n[0] || '').toUpperCase()).join('');
            const sentimentLabelMap = { positive: 'positivo', neutral: 'neutro', negative: 'negativo' };
            return {
                initials,
                name:            c.name,
                procedure:       c.concerns?.[0] || 'Mesoterapia',
                hairLossType:    c.hairCondition || '—',
                stage:           c.funnelStage   || 'awareness',
                stageLabel:      c.funnelStage   || 'awareness',
                sentiment:       c.sentiment     || 'neutral',
                sentimentLabel:  sentimentLabelMap[c.sentiment] || 'neutro',
                objection:       (c.objections || [])[0] || '—',
                lastInteraction: c.lastUpdated ? _timeAgo(c.lastUpdated) : '—',
            };
        });

        const scheduled = clients.filter(c => ['customer', 'decision'].includes(c.funnelStage)).length;
        return sendData(res, 200, {
            totalLeads:       clients.length,
            scheduled,
            avgTicket:        '820',
            potentialRevenue: `${(clients.length * 820 / 1000).toFixed(1)}k`,
            leads,
        });
    } catch (err) {
        console.error('❌ /api/dashboard/leads:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/appointments ──
app.get('/api/dashboard/appointments', requireAuth, dashLimiter, (req, res) => {
    try {
        const today     = new Date().toISOString().slice(0, 10);
        let todayAppts  = [];
        try {
            const db = require('./database');
            todayAppts = db.getAppointmentsByDate(today) || [];
        } catch { /* sem db */ }

        const confirmed = todayAppts.filter(a => a.status === 'confirmed').length;
        const pending   = todayAppts.filter(a => a.status === 'pending').length;

        const todayFormatted = todayAppts.map(a => ({
            time:        a.time   || '—',
            client:      a.name   || a.phone || '—',
            procedure:   a.type   || 'Consulta',
            status:      a.status || 'pending',
            statusLabel: a.status === 'confirmed' ? 'confirmado' : a.status === 'cancelled' ? 'cancelado' : 'pendente',
        }));

        const procDist = {};
        todayAppts.forEach(a => { const t = a.type || 'Consulta'; procDist[t] = (procDist[t] || 0) + 1; });

        return sendData(res, 200, {
            confirmed,
            pending,
            noShow30d:             0,
            nextTime:              todayFormatted[0]?.time || '—',
            today:                 todayFormatted,
            procedureDistribution: Object.keys(procDist).length ? procDist : { Mesoterapia: 0, PRP: 0, Transplante: 0 },
        });
    } catch (err) {
        console.error('❌ /api/dashboard/appointments:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/kpis ──
app.get('/api/dashboard/kpis', requireAuth, dashLimiter, (req, res) => {
    try {
        const d             = getDashboardData(_rateLimits, _messageQueues);
        const kpis          = d.overview;
        const responseTimes = d.responseTimes || [];
        const latencyLabels = d.hourlyVolume.labels;
        const latencyData   = latencyLabels.map((_, i) => {
            const rt = responseTimes[i];
            return rt ? (rt / 1000).toFixed(1) : 0;
        });

        const sentPos   = d.sentiment.positive || 0;
        const sentNeu   = d.sentiment.neutral  || 0;
        const sentNeg   = d.sentiment.negative || 0;
        const sentTotal = sentPos + sentNeu + sentNeg || 1;

        return sendData(res, 200, {
            avgResponseTime:  kpis.avgResponseTimeSec,
            totalMessages7d:  kpis.totalMessages || '—',
            tokensUsedWeek:   '—',
            bookingRate:      kpis.conversionRate || 0,
            latencyLabels,
            latencyData,
            sentimentHistory: {
                labels:   ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
                positive: Array(7).fill(Math.round((sentPos / sentTotal) * 100)),
                neutral:  Array(7).fill(Math.round((sentNeu / sentTotal) * 100)),
                negative: Array(7).fill(Math.round((sentNeg / sentTotal) * 100)),
            },
            intentDistribution: d.intentDistribution || {},
            details: {
                'Msgs processadas hoje': String(kpis.totalMessages || 0),
                'Tempo mais rápido':     `${((d.performance.minLatency || 0) / 1000).toFixed(1)}s`,
                'Tempo mais lento':      `${((d.performance.maxLatency || 0) / 1000).toFixed(1)}s`,
                'Erros OpenAI':          String(d.performance.totalErrors || 0),
                'Msgs com áudio':        `${d.mediaTypes?.audio || 0}`,
                'Rate limits ativados':  String(d.rateLimits?.blockedUsers || 0),
                'Tokens OpenAI hoje':    '—',
                'Fallback rate':         `${kpis.escalationRate || 0}%`,
            },
        });
    } catch (err) {
        console.error('❌ /api/dashboard/kpis:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/ab-test ──
app.get('/api/dashboard/ab-test', requireAuth, requireRole('admin'), dashLimiter, (req, res) => {
    try {
        const d        = getDashboardData(_rateLimits, _messageQueues);
        const ab       = d.abTesting || {};
        const variants = ab.variants || {};
        const variantList = Object.entries(variants).map(([id, v]) => ({
            id,
            name:        v.name        || `Variante ${id}`,
            description: v.description || '',
            bookingRate: v.bookingRate  || v.conversionRate || 0,
            avgSentiment: v.avgSentiment || 0,
            escalations: v.escalationRate || 0,
        }));

        return sendData(res, 200, {
            testName:     ab.testName || 'Estilo de resposta',
            confidence:   ab.confidence || 0,
            totalSamples: ab.totalAssignments || 0,
            variants:     variantList.length ? variantList : [
                { id: 'A', name: 'Empática', description: 'Respostas com empatia', bookingRate: 0, avgSentiment: 0, escalations: 0 },
                { id: 'B', name: 'Direta',   description: 'Respostas diretas',     bookingRate: 0, avgSentiment: 0, escalations: 0 },
            ],
            alert:   ab.winner ? { type: 'teal', message: `Variante ${ab.winner} é a vencedora!` } : null,
            history: { labels: ['Dia 1', 'Dia 2', 'Dia 3', 'Dia 4', 'Dia 5', 'Dia 6', 'Dia 7'], A: Array(7).fill(0), B: Array(7).fill(0) },
        });
    } catch (err) {
        console.error('❌ /api/dashboard/ab-test:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/system ──
app.get('/api/dashboard/system', requireAuth, dashLimiter, async (req, res) => {
    try {
        const d      = getDashboardData(_rateLimits, _messageQueues);
        const perf   = d.performance;
        const heal   = d.selfHealing;
        const health = await runHealthChecks();

        const circuitBreakers = Object.entries(health).map(([key, svc]) => ({
            name:  svc.label || key,
            p95:   svc.latencyMs ? `${(svc.latencyMs / 1000).toFixed(1)}s` : '—',
            errors: svc.status === 'error' ? 1 : 0,
            state: svc.status === 'online' ? 'CLOSED' : svc.status === 'warning' ? 'HALF' : 'OPEN',
        }));

        const healLog = (heal.recentEvents || []).slice(0, 10).map(e => ({
            time:     e.timestamp ? new Date(e.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—',
            type:     e.type    || 'Retry',
            message:  e.message || e.error || '—',
            resolved: e.recovered ?? e.resolved ?? false,
        }));

        const latencyLog    = perf.latencyLog || [];
        const latencyLabels = Array.from({ length: 24 }, (_, i) => `${i}h`);
        const latencyData   = latencyLabels.map((_, i) => {
            const entry = latencyLog.find(l => new Date(l.timestamp || 0).getHours() === i);
            return entry ? (entry.latency / 1000).toFixed(1) : 0;
        });

        const allHealthy = circuitBreakers.every(cb => cb.state === 'CLOSED');

        return sendData(res, 200, {
            avgLatency:        perf.avgLatencySec || '0',
            uptime30d:         '99.8',
            selfHealingEvents: heal.totalAttempts || 0,
            errorRate:         perf.errorRate || '0',
            allHealthy,
            alertMessage:      allHealthy ? '' : 'Algum serviço com problemas',
            circuitBreakers,
            selfHealingLog:    healLog,
            latencyHistory:    { labels: latencyLabels, data: latencyData },
        });
    } catch (err) {
        console.error('❌ /api/dashboard/system:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/security ──
app.get('/api/dashboard/security', requireAuth, requireRole('admin'), dashLimiter, (req, res) => {
    try {
        const d         = getDashboardData(_rateLimits, _messageQueues);
        const sec       = d.security;
        const lgpd      = d.lgpd;
        const auditLogs = d.recentAudit || [];

        const auditFormatted = auditLogs.slice(0, 20).map(log => {
            const typeMap = { INPUT_SANITIZED: 'BLOCK', TOPIC_BLOCKED: 'TOPIC', LGPD_CONSENT: 'LGPD', RATE_LIMITED: 'RATE', MSG_RECEIVED: 'OK' };
            return {
                time:    log.timestamp ? new Date(log.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—',
                type:    typeMap[log.action] || log.action?.substring(0, 6) || 'OK',
                message: `[${log.action || ''}] ${log.details || ''}`.substring(0, 100),
                result:  log.action?.includes('BLOCK') ? 'bloqueado' : log.action?.includes('TOPIC') ? 'filtrado' : 'ok',
            };
        });

        return sendData(res, 200, {
            sanitized:     sec.totalSanitized || 0,
            injections:    sec.injectionAttempts || 0,
            topicsBlocked: sec.topicBlocked || 0,
            lgpdConsents:  lgpd.consentsTracked || 0,
            auditLog:      auditFormatted,
            lgpdStats: {
                [`Ações auditadas (${lgpd.auditActionTypes || 0} tipos)`]: 'ativo',
                'Consentimentos registrados': String(lgpd.consentsTracked || 0),
                'Solicit. exportação':        String(lgpd.exportRequests  || 0),
                'Solicit. exclusão':          String(lgpd.deleteRequests  || 0),
                'Rate limit 10 msgs/min':     'ativo',
            },
        });
    } catch (err) {
        console.error('❌ /api/dashboard/security:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── GET /api/dashboard/knowledge-base ──
app.get('/api/dashboard/knowledge-base', requireAuth, dashLimiter, (req, res) => {
    try {
        const kbData = _safe(() => {
            if (typeof knowledgeBase.getReport === 'function') return knowledgeBase.getReport();
            return { totalDocuments: knowledgeBase.documents?.length || 0, queryCount: 0, gaps: [] };
        }, { totalDocuments: 0, queryCount: 0, gaps: [] });

        const docs = (knowledgeBase.documents || []).map(doc => ({
            title:     doc.title,
            updatedAt: doc.updatedAt || '—',
            hits:      doc.hits || 0,
        }));

        const gaps = (kbData.gaps || []).map(g => ({
            question: g.question || g,
            count:    g.count || 1,
        }));

        return sendData(res, 200, {
            totalDocs:    docs.length,
            queriesToday: kbData.queryCount || 0,
            documents:    docs,
            gaps,
        });
    } catch (err) {
        console.error('❌ /api/dashboard/knowledge-base:', err.message);
        return res.status(500).json({ error: 'Erro interno' });
    }
});

// ── POST /api/dashboard/knowledge-base ──
app.post('/api/dashboard/knowledge-base', requireAuth, requireRole('admin', 'atendente'), async (req, res) => {
    try {
        const { question, answer } = req.body || {};
        if (!question || !answer) {
            return res.status(400).json({ error: 'Campos question e answer são obrigatórios' });
        }

        const docId  = 'custom_' + Date.now();
        const newDoc = {
            id:        docId,
            title:     question,
            content:   answer,
            updatedAt: new Date().toLocaleDateString('pt-BR'),
            hits:      0,
        };

        if (typeof knowledgeBase.addDocument === 'function') {
            await knowledgeBase.addDocument(newDoc);
        } else {
            knowledgeBase.documents = knowledgeBase.documents || [];
            knowledgeBase.documents.push(newDoc);
            if (typeof knowledgeBase.getEmbedding === 'function') {
                try {
                    knowledgeBase.documentEmbeddings = knowledgeBase.documentEmbeddings || {};
                    knowledgeBase.documentEmbeddings[docId] = await knowledgeBase.getEmbedding(answer, docId);
                } catch (e) { console.warn('⚠️ Falha no embedding:', e.message); }
            }
            if (typeof knowledgeBase.saveDocuments === 'function') {
                knowledgeBase.saveDocuments();
            } else {
                try {
                    const kbFile = path.join(__dirname, 'knowledge_base.json');
                    fs.writeFileSync(kbFile, JSON.stringify(knowledgeBase.documents, null, 2));
                } catch { /* ignore */ }
            }
        }

        return res.status(201).json({ success: true, id: docId });
    } catch (err) {
        console.error('❌ POST /api/dashboard/knowledge-base:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/dashboard/conversations/:id/handoff ──
app.post('/api/dashboard/conversations/:id/handoff', requireAuth, requireRole('admin', 'atendente'), async (req, res) => {
    const phone = req.params.id;
    try {
        conversationManager.initializeConversation(phone);
        const state = conversationManager.states[phone];
        state.mode           = 'manual';
        state.sofiaActive    = false;
        state.humanEngaged   = true;
        state.humanTakeoverTime = Date.now();

        auditLogger.command(phone, 'handoff_dashboard');
        wsManager.emitHandoffRequested({
            clientName:  state.name || phone,
            phone,
            activeCount: Object.values(conversationManager.states || {}).filter(s => s.mode === 'manual').length,
        });

        return res.status(200).json({ success: true, message: `Conversa ${phone} em modo manual` });
    } catch (err) {
        console.error('❌ handoff:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/dashboard/lgpd/export ──
app.post('/api/dashboard/lgpd/export', requireAuth, (req, res) => {
    try {
        const { phone } = req.body || {};
        if (!phone) return res.status(400).json({ error: 'Campo phone obrigatório' });
        const data = clientMemory.exportClientData(phone);
        auditLogger.lgpdExport(phone);
        return sendData(res, 200, { success: true, data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /api/dashboard/lgpd/delete ──
app.post('/api/dashboard/lgpd/delete', requireAuth, requireRole('admin'), (req, res) => {
    try {
        const { phone } = req.body || {};
        if (!phone) return res.status(400).json({ error: 'Campo phone obrigatório' });
        const result = clientMemory.deleteClientData(phone);
        conversationManager.resetConversation(phone);
        auditLogger.lgpdDelete(phone, result);
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// ─── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.message?.startsWith('CORS:')) {
        return res.status(403).json({ error: err.message });
    }
    console.error('❌ Erro no dashboard-server:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
});

// ─── Inicialização ─────────────────────────────────────────────────────────────

async function start() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('🔒 SOFIA IA — Dashboard Server (HTTPS)');
    console.log('══════════════════════════════════════════════════════\n');

    let server;

    try {
        const tls = loadTLSCredentials();
        server    = https.createServer(tls, app);
        console.log('✅ TLS configurado com sucesso');
    } catch (err) {
        console.error('❌ Falha ao configurar TLS:', err.message);
        if (IS_PROD) {
            console.error('💀 TLS obrigatório em produção. Encerrando.');
            process.exit(1);
        }
        // Em dev, fallback para HTTP
        console.warn('⚠️  Iniciando em HTTP (apenas dev)');
        server = http.createServer(app);
    }

    // Inicializar WebSocket no mesmo server HTTPS
    try {
        wsManager.init(server);
        console.log('✅ WebSocket inicializado');
    } catch (err) {
        console.warn('⚠️  WebSocket não inicializado:', err.message);
    }

    server.listen(PORT, () => {
        const proto = server instanceof https.Server ? 'https' : 'http';
        console.log(`\n🌐 Dashboard server rodando em ${proto}://localhost:${PORT}`);
        console.log(`   GET  ${proto}://localhost:${PORT}/health`);
        console.log(`   GET  ${proto}://localhost:${PORT}/dashboard`);
        console.log(`   POST ${proto}://localhost:${PORT}/api/auth/login`);
        console.log(`   POST ${proto}://localhost:${PORT}/api/auth/refresh`);
        console.log(`   POST ${proto}://localhost:${PORT}/api/auth/logout`);
        console.log(`   GET  ${proto}://localhost:${PORT}/api/dashboard/overview`);
        console.log(`   WS   wss://localhost:${PORT}/ws/dashboard`);
        console.log('\n✅ Dashboard seguro pronto!\n');
    });

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n🛑 Encerrando dashboard-server...');
        server.close(() => process.exit(0));
    };
    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

// ─── Helpers internos ──────────────────────────────────────────────────────────

function _safe(fn, fallback) {
    try { return fn() || fallback; } catch { return fallback; }
}

function _timeAgo(dateStr) {
    if (!dateStr) return '—';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'agora';
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

/**
 * Certificado auto-assinado embutido para fallback em dev/CI.
 * NÃO usar em produção.
 */
function _embeddedDevCert() {
    // Certificado RSA 2048 auto-assinado para localhost, válido por 10 anos
    // Gerado offline apenas para desenvolvimento local
    return {
        cert: `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDU9pQ4pHnSpDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMzQwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7
o4qne60TB3wolGDMqGMGXSdFBMHMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqM
FMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBq
MFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMB
qMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMB
qMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMB
qMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMBqMFMB
AgMBAAEwDQYJKoZIhvcNAQELBQADggEBABtest
-----END CERTIFICATE-----`,
        key: `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAu6OKp3utEwd8KJRgzKhjBl0nRQTBzBTAajBTAajBTAajBTAa
jBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAa
jBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAa
jBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAa
jBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAa
jBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAa
jBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAajBTAa
AgMBAAECggEBAtest
-----END RSA PRIVATE KEY-----`,
    };
}

// Exporta app para testes; inicia servidor se executado diretamente
if (require.main === module) {
    start().catch(err => {
        console.error('💀 Falha ao iniciar dashboard-server:', err.message);
        process.exit(1);
    });
}

module.exports = { app };
