'use strict';

const { OpenAI } = require('openai');
const leadDB = require('../leadDB');

let qualificationOpenAI = null;

const QUALIFICATION_MODEL = process.env.OPENAI_QUALIFICATION_MODEL || 'gpt-4o';
const DEFAULT_SIGNALS = {
  interesse_principal: 'nao_identificado',
  tempo_problema: 'nao_informado',
  tratamento_anterior: null,
  urgencia: 'nao_identificada',
  decide_sozinho: null,
  abertura_investimento: 'nao_informado',
  sentimento: 'neutro',
  objecao_detectada: 'nenhuma',
  pronto_para_agendamento: false,
};

function getOpenAIClient() {
  if (qualificationOpenAI) return qualificationOpenAI;
  if (!process.env.OPENAI_API_KEY) return null;

  qualificationOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return qualificationOpenAI;
}

function normalizeEnum(value, allowedValues, fallback) {
  return allowedValues.has(value) ? value : fallback;
}

function normalizeBoolean(value, fallback = null) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeSinais(rawSignals = {}) {
  return {
    interesse_principal: normalizeEnum(
      rawSignals.interesse_principal,
      new Set(['queda', 'crescimento', 'caspa', 'oleosidade', 'outro', 'nao_identificado']),
      DEFAULT_SIGNALS.interesse_principal,
    ),
    tempo_problema: normalizeEnum(
      rawSignals.tempo_problema,
      new Set(['dias', 'semanas', '1_mes', '3_meses', '6_meses', '1_ano', 'mais_1_ano', 'nao_informado']),
      DEFAULT_SIGNALS.tempo_problema,
    ),
    tratamento_anterior: normalizeBoolean(rawSignals.tratamento_anterior),
    urgencia: normalizeEnum(
      rawSignals.urgencia,
      new Set(['baixa', 'media', 'alta', 'nao_identificada']),
      DEFAULT_SIGNALS.urgencia,
    ),
    decide_sozinho: normalizeBoolean(rawSignals.decide_sozinho),
    abertura_investimento: normalizeEnum(
      rawSignals.abertura_investimento,
      new Set(['sim', 'talvez', 'nao', 'nao_informado']),
      DEFAULT_SIGNALS.abertura_investimento,
    ),
    sentimento: normalizeEnum(
      rawSignals.sentimento,
      new Set(['positivo', 'neutro', 'negativo', 'ansioso']),
      DEFAULT_SIGNALS.sentimento,
    ),
    objecao_detectada: normalizeEnum(
      rawSignals.objecao_detectada,
      new Set(['preco', 'tempo', 'desconfianca', 'nenhuma', 'nao_identificada']),
      DEFAULT_SIGNALS.objecao_detectada,
    ),
    pronto_para_agendamento: normalizeBoolean(rawSignals.pronto_para_agendamento, false),
  };
}

function formatHistoryForQualification(historicoConversa = []) {
  return (historicoConversa || [])
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: String(message.content || message.conteudo || '').slice(0, 280),
      timestamp: message.timestamp || null,
    }));
}

async function extrairSinaisQualificacao(leadId, ultimaMensagem, historicoConversa) {
  const openai = getOpenAIClient();
  if (!openai) {
    console.warn('[qualificacaoCapilar] OPENAI_API_KEY ausente; extração de sinais indisponível');
    return null;
  }

  const payload = {
    leadId,
    ultimaMensagem,
    historicoConversa: formatHistoryForQualification(historicoConversa),
  };

  try {
    const response = await openai.chat.completions.create({
      model: QUALIFICATION_MODEL,
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Você é um analisador de conversas de clínica capilar.',
            'Analise a mensagem atual e o histórico recente do lead.',
            'Extraia sinais de qualificação progressiva adaptados ao contexto capilar.',
            'Não use pedido genérico de agendamento como sinal suficiente de qualificação alta.',
            'Se o problema capilar ainda não estiver claro, use interesse_principal=nao_identificado.',
            'Se o tempo do problema não foi dito, use tempo_problema=nao_informado.',
            'Se a urgência não estiver explícita, use nao_identificada.',
            'Responda apenas JSON válido com as chaves solicitadas.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim();
    return normalizeSinais(JSON.parse(raw || '{}'));
  } catch (error) {
    console.error(`[qualificacaoCapilar] Erro ao extrair sinais para ${leadId}: ${error.message}`);
    return null;
  }
}

function avaliarNivelQualificacao(sinais) {
  if (!sinais) return 'em_qualificacao';

  const normalized = normalizeSinais(sinais);
  let pontos = 0;

  if (normalized.interesse_principal && normalized.interesse_principal !== 'nao_identificado') {
    pontos += normalized.interesse_principal === 'outro' ? 15 : 25;
  }

  const tempoMap = {
    mais_1_ano: 20,
    '1_ano': 18,
    '6_meses': 15,
    '3_meses': 12,
    '1_mes': 10,
    semanas: 5,
    dias: 3,
    nao_informado: 0,
  };
  pontos += tempoMap[normalized.tempo_problema] || 0;

  const urgenciaMap = { alta: 20, media: 10, baixa: 5, nao_identificada: 0 };
  pontos += urgenciaMap[normalized.urgencia] || 0;

  if (normalized.tratamento_anterior === false) pontos += 10;
  if (normalized.abertura_investimento === 'sim') pontos += 15;
  else if (normalized.abertura_investimento === 'talvez') pontos += 7;

  if (normalized.sentimento === 'positivo') pontos += 10;
  if (normalized.decide_sozinho === true) pontos += 5;

  const hasNeed = normalized.interesse_principal && normalized.interesse_principal !== 'nao_identificado';
  const hasProblemContext =
    normalized.tempo_problema !== 'nao_informado'
    || typeof normalized.tratamento_anterior === 'boolean'
    || normalized.urgencia !== 'nao_identificada';

  if (!hasNeed) {
    return pontos >= 20 ? 'em_qualificacao' : 'nao_qualificado';
  }

  // Não qualifique alto só porque a pessoa pediu agenda sem contexto capilar real.
  if (!hasProblemContext) {
    return 'em_qualificacao';
  }

  if (pontos >= 70 && normalized.pronto_para_agendamento) return 'hot';
  if (pontos >= 45) return 'qualificado';
  if (pontos >= 20) return 'em_qualificacao';
  return 'nao_qualificado';
}

function proximaPerguntaQualificacao(sinais) {
  if (!sinais) {
    return 'Oi, tudo bem? Me conta: você está buscando ajuda para queda, crescimento, caspa ou outro incômodo no couro cabeludo?';
  }

  const normalized = normalizeSinais(sinais);

  if (!normalized.interesse_principal || normalized.interesse_principal === 'nao_identificado') {
    return 'Me conta melhor: é queda, algum desconforto no couro cabeludo, ou outra coisa?';
  }

  if (!normalized.tempo_problema || normalized.tempo_problema === 'nao_informado') {
    return `Entendi, ${normalized.interesse_principal === 'queda' ? 'a queda' : 'isso'} está acontecendo há quanto tempo?`;
  }

  if (normalized.tratamento_anterior === null) {
    return 'Você já fez algum tratamento antes para isso, ou é a primeira vez que busca ajuda?';
  }

  if (normalized.objecao_detectada && !['nenhuma', 'nao_identificada'].includes(normalized.objecao_detectada)) {
    return null;
  }

  return null;
}

function mapNivelToEtapaFunil(nivel) {
  switch (nivel) {
    case 'hot':
      return 'hot';
    case 'qualificado':
      return 'qualificado';
    case 'em_qualificacao':
      return 'em_qualificacao';
    default:
      return 'novo';
  }
}

async function processarQualificacao(lead, ultimaMensagem, historicoConversa) {
  const sinais = await extrairSinaisQualificacao(lead.lead_id, ultimaMensagem, historicoConversa);

  if (!sinais) {
    return { status: 'erro', proximaAcao: 'continuar_conversa' };
  }

  const nivel = avaliarNivelQualificacao(sinais);
  const persisted = await leadDB.atualizarQualificacaoCapilar(lead.lead_id, sinais, nivel);
  const proximaPergunta = proximaPerguntaQualificacao(sinais);

  return {
    status: 'ok',
    nivel,
    sinais,
    qualificacao: persisted.qualificacao,
    etapaFunil: persisted.etapaFunil || mapNivelToEtapaFunil(nivel),
    proximaAcao: proximaPergunta ? 'continuar_qualificacao' : 'oferecer_agendamento',
    proximaPergunta,
  };
}

module.exports = {
  extrairSinaisQualificacao,
  avaliarNivelQualificacao,
  proximaPerguntaQualificacao,
  processarQualificacao,
};