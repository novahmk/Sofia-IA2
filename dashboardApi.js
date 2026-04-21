/**
 * DASHBOARD API — Endpoints REST + SSE para o dashboard React
 * ══════════════════════════════════════════════════════════════
 * Montado no Express do whatsappExpressWebhook como:
 *   app.use('/api', require('./dashboardApi'));
 *
 * Endpoints:
 *   GET /api/sse          — Stream de eventos em tempo real (SSE)
 *   GET /api/stats        — Estatísticas gerais
 *   GET /api/leads        — Lista de leads
 *   GET /api/conversations/:phone — Histórico de conversa
 *   GET /api/playbooks    — Playbooks salvos
 *   GET /api/agents/stats — Performance por agente
 */

'use strict';

const express = require('express');
const router = express.Router();
const eventBus = require('./eventBus');

// Lazy requires para não quebrar boot se módulos falharem
function getDb() { return require('./database'); }
function getPlaybooks() { return require('./improvement/playbookStorage'); }
function getSelfImprovement() { return require('./improvement/selfImprovement'); }

// ── Auth simples via Bearer token ──────────────────────────────
function authMiddleware(req, res, next) {
  const apiSecret = process.env.DASHBOARD_API_SECRET || process.env.JWT_SECRET;
  if (!apiSecret) return next(); // sem secret configurado → sem auth (dev)

  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token || token !== apiSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── CORS para o React em dev (localhost:5173) e prod ──────────
router.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    process.env.DASHBOARD_ORIGIN,
    'http://localhost:5173',
    'http://localhost:3001',
  ].filter(Boolean);

  if (allowed.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── SSE — Stream de eventos em tempo real ─────────────────────
router.get('/sse', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx compatibility
  res.flushHeaders();

  // Heartbeat a cada 25s para manter a conexão viva
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  // Envia evento formatado como SSE
  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Snapshot inicial com stats
  try {
    const selfImp = getSelfImprovement();
    const stats = selfImp.getStats();
    const pb = getPlaybooks();
    send({
      type: 'connected',
      payload: {
        agentStats: stats.stats,
        playbookCount: pb.getTop(100).length,
        ts: Date.now(),
      },
    });
  } catch (e) {
    send({ type: 'connected', payload: { ts: Date.now() } });
  }

  // Inscreve no bus
  eventBus.on('event', send);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off('event', send);
  });
});

// ── GET /api/stats ─────────────────────────────────────────────
router.get('/stats', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const selfImp = getSelfImprovement();
    const pb = getPlaybooks();

    const leads = Object.values(db.getAll('leads') || {});
    const memories = Object.values(db.getAll('client_memories') || {});

    const stageCount = leads.reduce((acc, l) => {
      const s = l?.etapa_funil || 'desconhecido';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    const agentStats = selfImp.getStats();
    const topPlaybooks = pb.getTop(5);

    res.json({
      leads: {
        total: leads.length,
        byStage: stageCount,
      },
      agents: agentStats.stats,
      playbooks: {
        total: pb.getTop(1000).length,
        top5: topPlaybooks,
      },
      statsSince: agentStats.since,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/leads ─────────────────────────────────────────────
router.get('/leads', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const raw = db.getAll('leads') || {};

    const leads = Object.values(raw).map((l) => ({
      phone: l?.phone || l?.lead_id,
      nome: l?.nome,
      etapa_funil: l?.etapa_funil,
      ultima_interacao: l?.ultima_interacao,
      follow_up_count: l?.follow_up_count || 0,
      follow_up_enviado: l?.follow_up_enviado || false,
    }));

    // Ordenar por última interação (mais recente primeiro)
    leads.sort((a, b) =>
      new Date(b.ultima_interacao || 0) - new Date(a.ultima_interacao || 0)
    );

    res.json({ leads, total: leads.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/conversations/:phone ─────────────────────────────
router.get('/conversations/:phone', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const phone = decodeURIComponent(req.params.phone);
    const lead = db.query
      ? null
      : db.getAll('leads')?.[phone];

    // Tenta via leads KV
    const leadData = db.getAll('leads')?.[phone];
    if (!leadData) {
      return res.json({ phone, messages: [], found: false });
    }

    const messages = (leadData.contexto_conversa || []).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));

    res.json({
      phone,
      nome: leadData.nome,
      etapa_funil: leadData.etapa_funil,
      messages,
      found: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/playbooks ─────────────────────────────────────────
router.get('/playbooks', authMiddleware, (req, res) => {
  try {
    const pb = getPlaybooks();
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const playbooks = pb.getTop(limit);
    res.json({ playbooks, total: playbooks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/agents/stats ──────────────────────────────────────
router.get('/agents/stats', authMiddleware, (req, res) => {
  try {
    const selfImp = getSelfImprovement();
    res.json(selfImp.getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
