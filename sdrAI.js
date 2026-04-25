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
 *   agendamento_retorno: string|null,  — ISO datetime ou null
 *   captured_data: object,
 *   conversation_phase: string
 * }
 */

const { OpenAI } = require('openai');

const FIRST_INTENTION_QUESTION = 'Oi, tudo bem? 😊 Me conta: você está buscando ajuda para queda, crescimento, oleosidade, caspa ou outro incômodo no couro cabeludo?';

const INTEREST_PATTERNS = [
  { key: 'queda', regex: /(queda|caindo|cair|rarefa[cç][aã]o|afinando|falhas?|entradas?|alopecia)/i },
  { key: 'crescimento', regex: /(crescimento|crescer|n[aã]o cresce|demora pra crescer|cresce pouco)/i },
  { key: 'caspa', regex: /(caspa|descama[cç][aã]o|descamando|pelinhas? branca)/i },
  { key: 'oleosidade', regex: /(oleosidade|oleoso|oleosa|seb[oó]rrea|muito oleo)/i },
];

const ADDITIONAL_SYMPTOMS = [
  { label: 'coceira', regex: /(coceira|co[aç]a|co[çc]ando)/i },
  { label: 'oleosidade', regex: /(oleosidade|oleoso|oleosa|seb[oó]rrea)/i },
  { label: 'ressecamento', regex: /(ressecado|ressecamento|seco|seca)/i },
  { label: 'caspa', regex: /(caspa|descama[cç][aã]o|descamando)/i },
  { label: 'sensibilidade', regex: /(sens[ií]vel|ard[êe]ncia|ardendo|dor no couro cabeludo)/i },
  { label: 'falhas', regex: /(falhas?|entradas?)/i },
];

const HIGH_URGENCY_PATTERNS = /(muito|bastante|urgente|cada vez pior|piorando|desesperad|caindo demais|caindo muito)/i;
const MEDIUM_URGENCY_PATTERNS = /(incomodando|preocupad|j[aá] faz tempo|h[aá] meses|constante)/i;

function normalizeText(value) {
  return String(value || '').trim();
}

function detectPrimaryInterest(text) {
  const normalized = normalizeText(text);
  for (const pattern of INTEREST_PATTERNS) {
    if (pattern.regex.test(normalized)) {
      return pattern.key;
    }
  }

  if (/(cabelo|couro cabeludo|fio|fios)/i.test(normalized)) {
    return 'outro';
  }

  return null;
}

function detectProblemDuration(text) {
  const normalized = normalizeText(text).toLowerCase();

  if (!normalized) return null;
  if (/(mais de 1 ano|mais de um ano|2 anos|3 anos|há anos|faz anos)/i.test(normalized)) return 'mais_1_ano';
  if (/(1 ano|um ano|há 1 ano|faz 1 ano)/i.test(normalized)) return '1_ano';
  if (/(6 meses|seis meses|meio ano|5 meses|4 meses)/i.test(normalized)) return '6_meses';
  if (/(3 meses|três meses|2 meses|dois meses)/i.test(normalized)) return '3_meses';
  if (/(1 mês|um mês|30 dias)/i.test(normalized)) return '1_mes';
  if (/(semana|semanas|15 dias)/i.test(normalized)) return 'semanas';
  if (/(hoje|ontem|dias?|alguns dias)/i.test(normalized)) return 'dias';

  return null;
}

function detectPreviousTreatment(text) {
  const normalized = normalizeText(text);

  if (!normalized) return null;
  if (/(nunca fiz|nunca tratei|primeira vez|n[aã]o fiz nada|n[aã]o tratei|nunca usei)/i.test(normalized)) {
    return false;
  }

  if (/(j[aá] fiz|j[aá] tratei|usei|estou usando|minoxidil|vitamina|dermatologista|tratamento|shampoo|rem[eé]dio)/i.test(normalized)) {
    return true;
  }

  return null;
}

function extractTreatmentDescription(text, treatmentFlag) {
  const normalized = normalizeText(text);
  if (treatmentFlag !== true || !normalized) return null;
  return normalized.slice(0, 180);
}

function detectAdditionalSymptom(text, primaryInterest = null) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const matches = ADDITIONAL_SYMPTOMS
    .filter((symptom) => symptom.regex.test(normalized) && symptom.label !== primaryInterest)
    .map((symptom) => symptom.label);

  if (matches.length === 0) return null;
  return [...new Set(matches)].join(', ');
}

function detectPerceivedUrgency(text, duration = null) {
  const normalized = normalizeText(text);

  if (HIGH_URGENCY_PATTERNS.test(normalized)) return 'alta';
  if (duration === '1_ano' || duration === 'mais_1_ano' || MEDIUM_URGENCY_PATTERNS.test(normalized)) return 'media';
  return 'baixa';
}

function normalizeCapturedData(rawData = {}, baseData = {}) {
  const previousTreatment = typeof rawData.tratamento_anterior === 'boolean'
    ? rawData.tratamento_anterior
    : baseData.tratamento_anterior ?? null;

  const urgency = ['baixa', 'media', 'alta'].includes(rawData.urgencia_percebida)
    ? rawData.urgencia_percebida
    : (baseData.urgencia_percebida || 'media');

  return {
    interesse_principal: rawData.interesse_principal || baseData.interesse_principal || null,
    tempo_problema: rawData.tempo_problema || baseData.tempo_problema || null,
    tratamento_anterior: previousTreatment,
    descricao_tratamento_anterior: previousTreatment
      ? (rawData.descricao_tratamento_anterior || baseData.descricao_tratamento_anterior || null)
      : null,
    sintoma_adicional: rawData.sintoma_adicional || baseData.sintoma_adicional || null,
    urgencia_percebida: urgency,
  };
}

function extractCapturedLeadData(text, lead = {}) {
  const primaryInterest = lead.interesse_principal || detectPrimaryInterest(text);
  const duration = lead.tempo_problema || detectProblemDuration(text);
  const previousTreatment = typeof lead.tratamento_anterior === 'boolean'
    ? lead.tratamento_anterior
    : detectPreviousTreatment(text);

  const baseData = {
    interesse_principal: primaryInterest,
    tempo_problema: duration,
    tratamento_anterior: previousTreatment,
    descricao_tratamento_anterior: lead.descricao_tratamento_anterior || extractTreatmentDescription(text, previousTreatment),
    sintoma_adicional: lead.sintoma_adicional || detectAdditionalSymptom(text, primaryInterest),
    urgencia_percebida: lead.urgencia_percebida || detectPerceivedUrgency(text, duration),
  };

  return normalizeCapturedData(baseData, {});
}

function hasConversationContext(capturedData = {}) {
  return Boolean(
    capturedData.tempo_problema
    || typeof capturedData.tratamento_anterior === 'boolean'
    || capturedData.sintoma_adicional
  );
}

function countAssistantQuestions(historico = []) {
  return historico
    .filter((message) => message.role === 'assistant')
    .reduce((total, message) => total + ((String(message.conteudo || message.content || '').match(/\?/g) || []).length), 0);
}

function detectConversationPhaseForSdr({ lead = {}, historico = [], capturedData = {} }) {
  const mergedData = normalizeCapturedData(capturedData, lead);
  const assistantQuestions = countAssistantQuestions(historico);

  if (!mergedData.interesse_principal) return 'phase_1_intention';
  if (assistantQuestions >= 3) return 'phase_3_transition';
  if (!hasConversationContext(mergedData)) return 'phase_2_deepening';
  return 'phase_3_transition';
}

function getDeepeningQuestion(capturedData = {}, lead = {}) {
  const mergedData = normalizeCapturedData(capturedData, lead);

  if (!mergedData.tempo_problema) {
    return 'Entendi. Isso está acontecendo há quanto tempo?';
  }

  if (typeof mergedData.tratamento_anterior !== 'boolean') {
    return 'Você já fez algum tratamento antes para isso, ou é a primeira vez que busca ajuda?';
  }

  if (!mergedData.sintoma_adicional) {
    return 'Tem sentido o couro cabeludo diferente, como coceira, oleosidade ou ressecamento?';
  }

  return 'Entendi. O que mais tem te incomodado nisso hoje?';
}

function buildDeterministicPhaseReply({ phase, capturedData = {}, lead = {} }) {
  if (phase === 'phase_1_intention' && !capturedData.interesse_principal) {
    return FIRST_INTENTION_QUESTION;
  }

  if (phase === 'phase_2_deepening') {
    return getDeepeningQuestion(capturedData, lead);
  }

  return null;
}

function enforceSingleQuestion(text) {
  const normalized = normalizeText(text);
  const questions = normalized.match(/\?/g) || [];

  if (questions.length <= 1) return normalized;

  const firstQuestionEnd = normalized.indexOf('?') + 1;
  const head = normalized.slice(0, firstQuestionEnd).trim();
  const tail = normalized.slice(firstQuestionEnd).replace(/\?/g, '.').trim();

  return tail ? `${head} ${tail}`.trim() : head;
}

const TRIGGERS_HUMANO = [
  /falar com (atendente|humano|pessoa)/i,
  /quero falar com algu[eé]m/i,
  /me passa o (número|contato|telefone)/i,
  /atendimento humano/i,
];

function detectarPedidoHumano(texto) {
  return TRIGGERS_HUMANO.some(r => r.test(texto));
}

const OUTPUT_FORMAT_INSTRUCTION = `IMPORTANTE: Responda SEMPRE em JSON válido com esta estrutura exata (sem markdown, sem blocos de código):
{
  "texto": "sua resposta para o lead aqui",
  "lead_status": "quente|morno|frio",
  "lead_intent": "agendamento|duvida|preco|curioso",
  "resumo_lead": "resumo em 1 frase",
  "score": 0,
  "agendamento_retorno": null,
  "conversation_phase": "phase_1_intention|phase_2_deepening|phase_3_transition",
  "captured_data": {
    "interesse_principal": null,
    "tempo_problema": null,
    "tratamento_anterior": null,
    "descricao_tratamento_anterior": null,
    "sintoma_adicional": null,
    "urgencia_percebida": "baixa|media|alta"
  }
}`;

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
🟢 Quente: demonstra prontidão para próximo passo, pede disponibilidade ou quer resolver logo
🟡 Morno: tem dúvidas, está pesquisando → conteúdo educativo + prova social
🔴 Frio: respostas curtas, baixo engajamento → nutrição leve

REGRAS DE FLUXO CONVERSACIONAL:

FASE 1 — ABERTURA
- Na primeira resposta da Sofia, NUNCA ofereça agendamento
- Na primeira resposta, faça apenas UMA pergunta aberta de intenção
- Modelo ideal: "Oi, tudo bem? 😊 Me conta: você está buscando ajuda para queda, crescimento, oleosidade, caspa ou outro incômodo no couro cabeludo?"
- Não peça dados pessoais, não fale de preço e não liste serviços na abertura

FASE 2 — APROFUNDAMENTO LEVE
- Faça UMA pergunta por mensagem
- Perguntas válidas: tempo do problema, tratamentos anteriores ou sintomas complementares
- Antes de perguntar, mostre que entendeu o que o lead disse
- Nunca faça mais de 3 perguntas de aprofundamento antes de transicionar

FASE 3 — TRANSIÇÃO NATURAL
- Só ofereça agendamento quando houver intenção clara + algum contexto do caso
- Use uma transição suave: acolhimento + próximo passo indicado + pergunta de confirmação
- Se o lead ainda não estiver pronto, ofereça explicação ou deixe a porta aberta

O QUE NUNCA FAZER:
- Não mencionar preços sem que o lead pergunte
- Não fazer mais de 2 tentativas de agendamento na mesma conversa
- Não enviar texto longo na primeira resposta
- Não usar linguagem agressiva de vendas

- Se lead mudar de assunto, retome o contexto com naturalidade
- O campo "agendamento_retorno" deve ser preenchido com ISO datetime SE o lead pedir para ser contactado depois (ex: "fala amanhã", "pode ser sexta")
- Caso contrário, "agendamento_retorno" deve ser null
- O objeto "captured_data" é obrigatório e deve refletir o que já foi descoberto sobre o lead

${OUTPUT_FORMAT_INSTRUCTION}`;

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
  const capturedData = extractCapturedLeadData(textoFinal, lead);
  const conversationPhase = detectConversationPhaseForSdr({ lead, historico, capturedData });

  // Detectar pedido de atendente humano sem gastar token
  if (detectarPedidoHumano(textoFinal)) {
    return {
      texto: 'Claro! Vou te conectar com nossa equipe agora. Só um momento 👋',
      lead_status: lead.status || 'morno',
      lead_intent: 'agendamento',
      resumo_lead: 'Lead pediu atendimento humano',
      score: lead.score ?? 50,
      agendamento_retorno: null,
      captured_data: capturedData,
      conversation_phase: conversationPhase,
      _pediu_humano: true,
    };
  }

  const deterministicReply = buildDeterministicPhaseReply({ phase: conversationPhase, capturedData, lead });
  if (deterministicReply) {
    return {
      texto: deterministicReply,
      lead_status: lead.status || (conversationPhase === 'phase_1_intention' ? 'frio' : 'morno'),
      lead_intent: capturedData.interesse_principal ? 'duvida' : 'curioso',
      resumo_lead: capturedData.interesse_principal
        ? `Lead buscando ajuda para ${capturedData.interesse_principal}`
        : 'Primeiro contato sem motivo principal definido',
      score: lead.score ?? (capturedData.interesse_principal ? 35 : 20),
      agendamento_retorno: null,
      captured_data: capturedData,
      conversation_phase: conversationPhase,
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

  systemContent += `\n\n[FASE ATUAL DA CONVERSA: ${conversationPhase}]`;
  systemContent += `\n[DADOS CAPTURADOS ATÉ AGORA: ${JSON.stringify(capturedData)}]`;

  // Montar mensagens para API
  const messages = [
    { role: 'system', content: systemContent },
    ...historico.map(h => ({ role: h.role, content: h.conteudo || h.content || '' })),
    { role: 'user', content: textoFinal },
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
    const normalizedCapturedData = normalizeCapturedData(parsed.captured_data || {}, capturedData);

    // Garantir campos mínimos
    return {
      texto: enforceSingleQuestion(parsed.texto || parsed.text || ''),
      lead_status: parsed.lead_status || 'morno',
      lead_intent: parsed.lead_intent || 'curioso',
      resumo_lead: parsed.resumo_lead || '',
      score: typeof parsed.score === 'number' ? parsed.score : (lead.score ?? 0),
      agendamento_retorno: parsed.agendamento_retorno || null,
      captured_data: normalizedCapturedData,
      conversation_phase: parsed.conversation_phase || conversationPhase,
    };
  } catch (e) {
    console.warn(`⚠️ [sdrAI] chamarIA falhou: ${e.message}`);
    // Fallback: resposta genérica sem falhar o fluxo
    return {
      texto: capturedData.interesse_principal
        ? getDeepeningQuestion(capturedData, lead)
        : FIRST_INTENTION_QUESTION,
      lead_status: lead.status || 'morno',
      lead_intent: capturedData.interesse_principal ? 'duvida' : 'curioso',
      resumo_lead: '',
      score: lead.score ?? 0,
      agendamento_retorno: null,
      captured_data: capturedData,
      conversation_phase: conversationPhase,
    };
  }
}

module.exports = {
  chamarIA,
  detectarPedidoHumano,
  detectConversationPhaseForSdr,
  extractCapturedLeadData,
  enforceSingleQuestion,
};
