/**
 * AGENTE CONTEXTO — Análise de intenção e respostas gerais
 * ══════════════════════════════════════════════════════════
 * - Analisa intenção da mensagem de forma rápida (sem chamada GPT)
 * - Atua como fallback quando nenhum agente especializado é selecionado
 * - Roteia para: commercial | technical | administrative | context (geral)
 */

'use strict';

const clientMemory = require('../clientMemory');
const { OpenAI } = require('openai');

let openaiClient = null;

class AgentContext {
  getOpenAIClient() {
    if (openaiClient) return openaiClient;
    if (!process.env.OPENAI_API_KEY) return null;

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
    const phone = lead?.telefone || lead?.lead_id;
    const memory = phone ? clientMemory.getClientMemory(phone) : null;
    const pendingScheduling = memory?.pendingScheduling;

    if (['waiting_day_preference', 'waiting_slot_selection', 'waiting_full_name'].includes(pendingScheduling?.step)) {
      return { type: 'scheduling', agent: 'administrative', entities: {}, reason: 'pending_scheduling_step' };
    }

    if (pendingScheduling?.step === 'pending_confirmation') {
      return { type: 'scheduling', agent: 'administrative', entities: {}, reason: 'pending_confirmation_step' };
    }

    return { type: 'general', agent: 'context', entities: {}, reason: 'default_general_fallback' };
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
      fallbackState: {
        agent: heuristic.agent,
        type: heuristic.type,
        reason: heuristic.reason || null,
      },
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
              'Não use listas fixas de palavras-chave como regra principal. Decida pelo significado da mensagem e pelo contexto.',
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
      lead.horasSemContato ? `Retomada após ${lead.horasSemContato}h sem contato` : '',
      historico ? `\nHistórico recente:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
    ]
      .filter(Boolean)
      .join('\n');

    return getSofiaResponse(phone, userMessage, leadContext);
  }
}

module.exports = new AgentContext();
