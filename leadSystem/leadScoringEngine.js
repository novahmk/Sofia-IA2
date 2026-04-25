'use strict';

/**
 * leadSystem/leadScoringEngine.js
 * Motor de scoring de leads adaptado ao contexto de clínica capilar.
 * Funciona com PostgreSQL e com fallback local em memória.
 */

const db = require('../database');
const leadMemory = require('./leadMemory');

const SCORE_HISTORY_PREFIX = 'lead_score_history:';

function parseJsonSafely(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeHistoryMessage(message = {}) {
  return {
    role: message.role,
    content: String(message.content || message.conteudo || '').trim(),
    timestamp: message.timestamp || null,
  };
}

class LeadScoringEngine {
  async calcularScore(leadId) {
    const lead = await leadMemory.getOrCreateLead(leadId);
    if (!lead) return null;

    const qualificacao = lead.qualificacao || {};
    const previousScore = Number(lead.lead_score ?? lead.score ?? 0) || 0;
    const { score, breakdown } = this._calcularPontos(lead, qualificacao);
    const temperatura = this._getTemperatura(score);
    const nivel = this._getNivel(score);
    const recomendacao = this._getRecomendacao(score, qualificacao);

    if (score !== previousScore) {
      await this._registrarHistorico(leadId, previousScore, score, temperatura, breakdown);
    }

    const nextQualificacao = {
      ...qualificacao,
      nivel_qualificacao: nivel,
      pronto_para_agendamento: score >= 70 ? true : qualificacao.pronto_para_agendamento === true,
    };

    await leadMemory.updateLead(leadId, {
      lead_score: score,
      score,
      temperatura,
      nivel_qualificacao: nivel,
      qualificacao: nextQualificacao,
      score_breakdown: breakdown,
      score_recomendacao: recomendacao,
      score_recalculado_em: new Date().toISOString(),
    });

    await this._persistirColunasEstruturadas(leadId, score, temperatura, nivel);

    return {
      score,
      temperatura,
      nivel,
      breakdown,
      recomendacao,
    };
  }

  _calcularPontos(lead, qualificacao) {
    const breakdown = {
      intencao: this._pontosIntencao(qualificacao.interesse_principal),
      tempo: this._pontosTempo(qualificacao.tempo_problema),
      tratamento: this._pontosTratamento(qualificacao.tratamento_anterior),
      urgencia: this._pontosUrgencia(qualificacao.urgencia || lead.urgencia_percebida),
      engajamento: this._pontosEngajamento(lead, qualificacao),
      investimento: this._pontosInvestimento(qualificacao.abertura_investimento),
    };

    const score = Object.values(breakdown).reduce((total, value) => total + value, 0);
    return {
      score: Math.min(100, Math.round(score)),
      breakdown,
    };
  }

  _pontosIntencao(interesse) {
    if (!interesse || interesse === 'nao_identificado') return 0;
    return 20;
  }

  _pontosTempo(tempo) {
    const mapa = {
      mais_1_ano: 20,
      '1_ano': 20,
      '6_meses': 15,
      '3_meses': 12,
      '1_mes': 8,
      semanas: 5,
      dias: 3,
      nao_informado: 0,
    };

    return mapa[tempo] || 0;
  }

  _pontosTratamento(tratouAntes) {
    if (tratouAntes === false) return 15;
    if (tratouAntes === true) return 10;
    return 0;
  }

  _pontosUrgencia(urgencia) {
    const mapa = {
      alta: 15,
      media: 8,
      baixa: 3,
      nao_identificada: 0,
    };

    return mapa[urgencia] || 0;
  }

  _pontosEngajamento(lead, qualificacao) {
    let pontos = 0;
    const historico = (lead.contexto_conversa || []).map(normalizeHistoryMessage);
    const mensagensUsuario = historico.filter((message) => message.role === 'user');
    const totalMensagens = Number(lead.total_mensagens_usuario ?? mensagensUsuario.length) || 0;

    if (totalMensagens >= 5) pontos += 10;
    else if (totalMensagens >= 3) pontos += 7;
    else if (totalMensagens >= 1) pontos += 3;

    const primeiroContato = lead.primeiro_contato || lead.created_at || lead.ultima_interacao;
    if (primeiroContato) {
      const diasDesde = Math.floor((Date.now() - new Date(primeiroContato).getTime()) / (1000 * 60 * 60 * 24));
      if (diasDesde <= 1) pontos += 5;
      else if (diasDesde <= 3) pontos += 3;
    }

    const ultimaMensagemUsuario = mensagensUsuario[mensagensUsuario.length - 1]?.content || '';
    const latestWords = ultimaMensagemUsuario.split(/\s+/).filter(Boolean).length;
    const knownSignals = [
      qualificacao.interesse_principal && qualificacao.interesse_principal !== 'nao_identificado',
      qualificacao.tempo_problema && qualificacao.tempo_problema !== 'nao_informado',
      typeof qualificacao.tratamento_anterior === 'boolean',
      qualificacao.urgencia && qualificacao.urgencia !== 'nao_identificada',
      qualificacao.abertura_investimento && qualificacao.abertura_investimento !== 'nao_informado',
    ].filter(Boolean).length;

    if (latestWords >= 4 || knownSignals >= 3) {
      pontos += 4;
    }

    if (latestWords >= 8 || knownSignals >= 4) {
      pontos += 3;
    }

    return Math.min(15, pontos);
  }

  _pontosInvestimento(abertura) {
    const mapa = {
      sim: 15,
      talvez: 8,
      nao: 0,
      nao_informado: 0,
    };

    return mapa[abertura] || 0;
  }

  _getTemperatura(score) {
    if (score >= 70) return 'hot';
    if (score >= 40) return 'warm';
    return 'cold';
  }

  _getNivel(score) {
    if (score >= 70) return 'hot';
    if (score >= 45) return 'qualificado';
    if (score >= 20) return 'em_qualificacao';
    return 'novo';
  }

  _getRecomendacao(score) {
    if (score >= 70) {
      return {
        acao: 'oferecer_agendamento',
        urgencia: 'alta',
        mensagem: 'Lead quente — oferecer agendamento imediatamente',
      };
    }

    if (score >= 45) {
      return {
        acao: 'continuar_qualificacao',
        urgencia: 'media',
        mensagem: 'Lead morno — continuar aprofundamento, oferecer agendamento em breve',
      };
    }

    if (score >= 20) {
      return {
        acao: 'educar',
        urgencia: 'baixa',
        mensagem: 'Lead frio — fornecer informações, não pressionar',
      };
    }

    return {
      acao: 'aguardar_resposta',
      urgencia: 'nenhuma',
      mensagem: 'Lead novo — aguardar mais dados',
    };
  }

  async _registrarHistorico(leadId, scoreAnterior, scoreNovo, temperatura, breakdown) {
    try {
      await db.query(
        `INSERT INTO lead_score_history
         (lead_id, score_anterior, score_novo, temperatura_nova, motivo, breakdown)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          leadId,
          scoreAnterior,
          scoreNovo,
          temperatura,
          'recalculo_apos_mensagem',
          JSON.stringify(breakdown),
        ]
      );
      return;
    } catch (_error) {
      const memoryKey = `${SCORE_HISTORY_PREFIX}${leadId}`;
      const entries = db.get('conversation_states', memoryKey) || [];
      entries.push({
        lead_id: leadId,
        score_anterior: scoreAnterior,
        score_novo: scoreNovo,
        temperatura_nova: temperatura,
        motivo: 'recalculo_apos_mensagem',
        breakdown,
        criado_em: new Date().toISOString(),
      });
      db.set('conversation_states', memoryKey, entries);
    }
  }

  async _persistirColunasEstruturadas(leadId, score, temperatura, nivel) {
    try {
      await db.query(
        `UPDATE leads SET
            lead_score = $1,
            temperatura = $2,
            nivel_qualificacao = $3,
            ultimo_contato = NOW()
          WHERE lead_id = $4`,
        [score, temperatura, nivel, leadId]
      );
    } catch (_error) {
      // Sem migrations ou sem banco configurado: já persistimos via JSON em leadMemory.
    }
  }

  async getDistribuicaoTemperatura() {
    try {
      const result = await db.query(
        `SELECT temperatura, COUNT(*) as total
           FROM leads
          WHERE COALESCE(etapa_funil, data->>'etapa_funil', 'novo') NOT IN ('fechado', 'inativo')
          GROUP BY temperatura`
      );
      return result.rows;
    } catch (_error) {
      const counters = new Map();
      const leads = Object.values(db.getAll('leads') || {});
      for (const lead of leads) {
        const etapaFunil = lead.etapa_funil || 'novo';
        if (['fechado', 'inativo'].includes(etapaFunil)) continue;

        const temperatura = lead.temperatura || 'cold';
        counters.set(temperatura, (counters.get(temperatura) || 0) + 1);
      }

      return Array.from(counters.entries()).map(([temperatura, total]) => ({ temperatura, total }));
    }
  }

  async getTopLeads(limit = 10) {
    try {
      const result = await db.query(
        `SELECT lead_id,
                data->>'nome' as nome,
                lead_score,
                temperatura,
                COALESCE(etapa_funil, data->>'etapa_funil', 'novo') as etapa_funil,
                ultimo_contato
           FROM leads
          WHERE COALESCE(etapa_funil, data->>'etapa_funil', 'novo') NOT IN ('fechado', 'inativo')
            AND temperatura IN ('hot', 'warm')
          ORDER BY lead_score DESC
          LIMIT $1`,
        [limit]
      );
      return result.rows;
    } catch (_error) {
      return Object.entries(db.getAll('leads') || {})
        .map(([leadId, lead]) => ({
          lead_id: leadId,
          nome: lead.nome || 'Cliente',
          lead_score: Number(lead.lead_score ?? lead.score ?? 0) || 0,
          temperatura: lead.temperatura || 'cold',
          etapa_funil: lead.etapa_funil || 'novo',
          ultimo_contato: lead.ultimo_contato || lead.ultima_interacao || null,
        }))
        .filter((lead) => !['fechado', 'inativo'].includes(lead.etapa_funil))
        .filter((lead) => ['hot', 'warm'].includes(lead.temperatura))
        .sort((left, right) => right.lead_score - left.lead_score)
        .slice(0, limit);
    }
  }

  getFallbackHistory(leadId) {
    return db.get('conversation_states', `${SCORE_HISTORY_PREFIX}${leadId}`) || [];
  }
}

module.exports = new LeadScoringEngine();