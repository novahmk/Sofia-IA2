'use strict';
/**
 * sdrAI.js — Chamada OpenAI com output JSON estruturado para o fluxo SDR
 *
 * Retorna:
 * {
 *   texto: string,           — resposta para o lead
 *   lead_status: string,     — quente | morno | frio
 *   lead_intent: string,     — agendamento | duvida | preco | curioso
 *   resumo_lead: string,     — resumo em 1 frase
 *   score: number,           — 0 a 100
 *   agendamento_retorno: string|null  — ISO datetime ou null
 * }
 */

const { OpenAI } = require('openai');

const TRIGGERS_HUMANO = [
  /falar com (atendente|humano|pessoa)/i,
  /quero falar com algu[eé]m/i,
  /me passa o (número|contato|telefone)/i,
  /atendimento humano/i,
];

function detectarPedidoHumano(texto) {
  return TRIGGERS_HUMANO.some(r => r.test(texto));
}

const SYSTEM_PROMPT_BASE = `Você é Sofia, consultora de Terapia Capilar da Clínica Quality Hair (Vila Mariana, metrô Paraíso, SP).

PERSONALIDADE:
- Tom humanizado, empático, acolhedor
- Nunca pareça robótica
- Responda de forma natural como uma consultora experiente
- Máximo 2-3 frases curtas por resposta

CLASSIFICAÇÃO OBRIGATÓRIA:
Após cada mensagem, classifique internamente o lead:
- lead_status: quente | morno | frio
- lead_intent: agendamento | duvida | preco | curioso
- score: 0 a 100

CRITÉRIOS:
🟢 Quente: pergunta preço, quer agendar, pergunta disponibilidade → ir direto para agendamento
🟡 Morno: tem dúvidas, está pesquisando → conteúdo educativo + prova social
🔴 Frio: respostas curtas, baixo engajamento → nutrição leve

REGRAS:
- NUNCA perguntar "quer agendar?" — SEMPRE ofereça 2 opções de horário diretamente
- Se lead mudar de assunto, retome o contexto de vendas naturalmente
- O campo "agendamento_retorno" deve ser preenchido com ISO datetime SE o lead pedir para ser contactado depois (ex: "fala amanhã", "pode ser sexta")
- Caso contrário, "agendamento_retorno" deve ser null`;

const OUTPUT_FORMAT_INSTRUCTION = `IMPORTANTE: Responda SEMPRE em JSON válido com esta estrutura exata (sem markdown, sem blocos de código):
{
  "texto": "sua resposta para o lead aqui",
  "lead_status": "quente|morno|frio",
  "lead_intent": "agendamento|duvida|preco|curioso",
  "resumo_lead": "resumo em 1 frase",
  "score": 0,
  "agendamento_retorno": null
}`;

/**
 * Chama a IA com output JSON estruturado.
 *
 * @param {object} params
 * @param {string} params.telefone
 * @param {string} params.textoFinal           — mensagem do lead
 * @param {Array}  params.historico            — [{role, conteudo}]
 * @param {object} params.lead                 — dados do lead do DB
 * @param {number|null} params.horasFrio       — horas sem resposta ou null
 * @param {boolean} params.isPrimeiroContato
 * @returns {Promise<object>}                  — objeto JSON da IA
 */
async function chamarIA({ telefone, textoFinal, historico, lead, horasFrio, isPrimeiroContato }) {
  // Detectar pedido de atendente humano sem gastar token
  if (detectarPedidoHumano(textoFinal)) {
    return {
      texto: 'Claro! Vou te conectar com nossa equipe agora. Só um momento 👋',
      lead_status: lead.status || 'morno',
      lead_intent: 'agendamento',
      resumo_lead: 'Lead pediu atendimento humano',
      score: lead.score ?? 50,
      agendamento_retorno: null,
      _pediu_humano: true,
    };
  }

  let systemContent = SYSTEM_PROMPT_BASE;

  // Contexto frio
  if (horasFrio) {
    systemContent += `\n\n[CONTEXTO: Lead ficou ${horasFrio}h sem responder. Retome com gentileza e resgate o interesse.]`;
  }

  // Status atual do lead
  if (lead.status && lead.status !== 'novo') {
    systemContent += `\n\n[STATUS ATUAL DO LEAD: ${lead.status} | Score: ${lead.score ?? 0} | Interesse: ${lead.procedimento_interesse || 'não identificado'}]`;
  }

  // Primeiro contato
  if (isPrimeiroContato) {
    systemContent += '\n\n[PRIMEIRO CONTATO: Apresente-se brevemente e descubra a necessidade do lead.]';
  }

  // Montar mensagens para API
  const messages = [
    { role: 'system', content: systemContent },
    ...historico.map(h => ({ role: h.role, content: h.conteudo || h.content || '' })),
    { role: 'user', content: textoFinal },
    { role: 'system', content: OUTPUT_FORMAT_INSTRUCTION },
  ];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0].message.content;
    const parsed = JSON.parse(raw);

    // Garantir campos mínimos
    return {
      texto: parsed.texto || parsed.text || '',
      lead_status: parsed.lead_status || 'morno',
      lead_intent: parsed.lead_intent || 'curioso',
      resumo_lead: parsed.resumo_lead || '',
      score: typeof parsed.score === 'number' ? parsed.score : (lead.score ?? 0),
      agendamento_retorno: parsed.agendamento_retorno || null,
    };
  } catch (e) {
    console.warn(`⚠️ [sdrAI] chamarIA falhou: ${e.message}`);
    // Fallback: resposta genérica sem falhar o fluxo
    return {
      texto: 'Recebi sua mensagem! Pode me contar mais sobre o que você busca? 😊',
      lead_status: lead.status || 'morno',
      lead_intent: 'curioso',
      resumo_lead: '',
      score: lead.score ?? 0,
      agendamento_retorno: null,
    };
  }
}

module.exports = { chamarIA, detectarPedidoHumano };
