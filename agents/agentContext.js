/**
 * AGENTE CONTEXTO — Análise de intenção e respostas gerais
 * ══════════════════════════════════════════════════════════
 * - Analisa intenção da mensagem de forma rápida (sem chamada GPT)
 * - Atua como fallback quando nenhum agente especializado é selecionado
 * - Roteia para: commercial | technical | administrative | context (geral)
 */

'use strict';

const clientMemory = require('../clientMemory');

let openaiClient = null;

// Mapeamentos de palavras-chave para tipo de intenção + agente responsável
const INTENT_MAP = [
  // Objeções comerciais
  {
    keywords: ['preço', 'valor', 'caro', 'barato', 'quanto custa', 'custo', 'desconto', 'parcel', 'investimento'],
    type: 'price_objection',
    agent: 'commercial',
  },
  {
    keywords: ['demora', 'tempo', 'resultado', 'quando vejo', 'quanto tempo', 'rápido'],
    type: 'time_objection',
    agent: 'commercial',
  },
  {
    keywords: ['vou pensar', 'não sei', 'talvez', 'pode ser', 'não tenho certeza', 'deixa eu ver'],
    type: 'hesitation',
    agent: 'commercial',
  },
  {
    keywords: ['funciona mesmo', 'garante', 'garantia', 'realmente funciona', 'de verdade'],
    type: 'trust_objection',
    agent: 'commercial',
  },
  // Técnicas
  {
    keywords: [
      'como funciona', 'o que é', 'qual a diferença', 'terapia capilar', 'tratamento',
      'procedimento', 'mesoterapia', 'prp', 'limpeza de pele', 'botox', 'transplante',
    ],
    type: 'product_info',
    agent: 'technical',
  },
  {
    keywords: [
      'queda', 'calvície', 'falha', 'afinamento', 'oleoso', 'caspa',
      'couro cabeludo', 'fios', 'cabelo', 'crescimento',
    ],
    type: 'symptom_question',
    agent: 'technical',
  },
  // Administrativas
  {
    keywords: ['cancelar', 'cancelo', 'cancelamento', 'não vou', 'nao vou', 'desisto'],
    type: 'schedule_cancellation',
    agent: 'administrative',
  },
  {
    keywords: ['remarcar', 'reagendar', 'desmarcar', 'mudar horário', 'mudar horario', 'adiar'],
    type: 'reschedule',
    agent: 'administrative',
  },
  {
    keywords: [
      'agendar', 'marcar', 'horário', 'disponível', 'agenda', 'consulta', 'avaliação',
      'quero ir', 'ir à clínica', 'visitar',
    ],
    type: 'scheduling',
    agent: 'administrative',
  },
  {
    keywords: ['confirmar', 'confirmo', 'confirmado', 'aceito', 'pode ser', 'combinado', 'fechado', 'ok', 'sim'],
    type: 'schedule_confirmation',
    agent: 'administrative',
  },
  {
    keywords: ['meu nome', 'meu telefone', 'meu email', 'meus dados', 'atualizar dados'],
    type: 'data_update',
    agent: 'administrative',
  },
];

class AgentContext {
  getOpenAIClient() {
    if (openaiClient) return openaiClient;
    if (!process.env.OPENAI_API_KEY) return null;

    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openaiClient;
  }

  buildRecentConversation(lead) {
    return (lead?.contexto_conversa || [])
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 300),
        timestamp: message.timestamp,
      }));
  }

  /**
   * Analisa a intenção de forma rápida (síncrona, zero custo de API)
   * @param {string} userMessage
   * @param {object} lead
   * @returns {{ type: string, agent: string, entities: object }}
   */
  analyzeIntention(userMessage, lead) {
    const msg = userMessage.toLowerCase().trim();
    const phone = lead?.telefone || lead?.lead_id;
    const memory = phone ? clientMemory.getClientMemory(phone) : null;
    const pendingScheduling = memory?.pendingScheduling;

    if (pendingScheduling?.step === 'waiting_slot_selection') {
      return { type: 'scheduling', agent: 'administrative', entities: {} };
    }

    if (pendingScheduling?.step === 'pending_confirmation') {
      if (['cancelar', 'desmarcar', 'remarcar', 'adiar'].some((k) => msg.includes(k))) {
        return { type: 'reschedule', agent: 'administrative', entities: {} };
      }

      if (['confirmar', 'confirmo', 'confirmado', 'aceito', 'pode ser', 'combinado', 'fechado', 'ok', 'sim'].some((k) => msg.includes(k))) {
        return { type: 'schedule_confirmation', agent: 'administrative', entities: {} };
      }

      return { type: 'scheduling', agent: 'administrative', entities: {} };
    }

    for (const pattern of INTENT_MAP) {
      if (pattern.keywords.some((k) => msg.includes(k))) {
        return { type: pattern.type, agent: pattern.agent, entities: {} };
      }
    }

    // Saudação ou mensagem genérica
    return { type: 'general', agent: 'context', entities: {} };
  }

  async analyzeIntentionWithAI(userMessage, lead) {
    const heuristic = this.analyzeIntention(userMessage, lead);
    const openai = this.getOpenAIClient();
    if (!openai) {
      return { ...heuristic, source: 'heuristic' };
    }

    const phone = lead?.telefone || lead?.lead_id;
    const memory = phone ? clientMemory.getClientMemory(phone) : null;
    const payload = {
      lead: {
        nome: lead?.nome || null,
        etapa_funil: lead?.etapa_funil || lead?.status || 'novo',
        follow_up_count: lead?.follow_up_count || 0,
      },
      pendingScheduling: memory?.pendingScheduling || null,
      activeScheduling: memory?.activeScheduling || null,
      recentConversation: this.buildRecentConversation(lead),
      latestUserMessage: userMessage,
      heuristic,
    };

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_ROUTER_MODEL || 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Você é um roteador de intenções da Sofia IA para uma clínica capilar.',
              'Classifique a mensagem mais recente considerando o contexto completo da conversa.',
              'Escolha um agente entre: commercial, technical, administrative, context.',
              'Escolha um tipo entre: price_objection, time_objection, hesitation, trust_objection, product_info, symptom_question, schedule_cancellation, reschedule, scheduling, schedule_confirmation, data_update, general.',
              'Use administrative para agendamento, confirmação, cancelamento, remarcação ou coleta de dados para concluir o agendamento.',
              'Se houver pendingScheduling.step=pending_confirmation e a mensagem confirmar, retorne schedule_confirmation.',
              'Se houver waiting_full_name e a mensagem trouxer nome completo, retorne scheduling.',
              'Responda apenas JSON com: agent, type, confidence, reason.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify(payload),
          },
        ],
      });

      const content = completion.choices?.[0]?.message?.content;
      const parsed = JSON.parse(content || '{}');
      const validAgents = new Set(['commercial', 'technical', 'administrative', 'context']);
      const validTypes = new Set([
        'price_objection', 'time_objection', 'hesitation', 'trust_objection',
        'product_info', 'symptom_question', 'schedule_cancellation', 'reschedule',
        'scheduling', 'schedule_confirmation', 'data_update', 'general',
      ]);

      if (!validAgents.has(parsed.agent) || !validTypes.has(parsed.type)) {
        return { ...heuristic, source: 'heuristic' };
      }

      return {
        agent: parsed.agent,
        type: parsed.type,
        entities: {},
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : heuristic.confidence,
        reason: parsed.reason || null,
        source: 'openai',
      };
    } catch (error) {
      console.warn(`⚠️ [AgentContext] Fallback heurístico: ${error.message}`);
      return { ...heuristic, source: 'heuristic' };
    }
  }

  /**
   * Resposta geral — agente padrão (usa getSofiaResponse com contexto do lead)
   */
  async respond(phone, userMessage, lead, intention) {
    const getSofiaResponse = require('../ai').getSofiaResponse;

    const historico = (lead.contexto_conversa || [])
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${m.content}`)
      .join('\n');

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      `Follow-ups realizados: ${lead.follow_up_count || 0}`,
      historico ? `\nHistórico recente:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
    ]
      .filter(Boolean)
      .join('\n');

    return getSofiaResponse(phone, userMessage, leadContext);
  }
}

module.exports = new AgentContext();
