require('dotenv').config();
const { OpenAI } = require('openai');
const swop = require('./swop');
const knowledgeBase = require('./knowledgeBase');
const functionCalling = require('./functionCalling');
const clientMemory = require('./clientMemory');
const selfHealing = require('./utils/selfHealing');
const abTesting = require('./abTesting');
const db = require('./database');
const { injetarContextoFrio } = require('./conversationDB');
const leadMemory = require('./leadSystem/leadMemory');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// ── Estado: in-memory com fallback para Redis (quando REDIS_URL configurado) ──
// getSync/setSync mantêm compatibilidade com o código síncrono existente;
// o Redis é atualizado em background via setSync.
const { chatHistoriesAdapter, customerIntentsAdapter } = require('./redisStateAdapter');
const chatHistories       = new Proxy({}, {
  get: (_, id) => chatHistoriesAdapter.getSync(id),
  set: (_, id, val) => { chatHistoriesAdapter.setSync(id, val); return true; },
  has: (_, id) => chatHistoriesAdapter.has(id),
  deleteProperty: (_, id) => { chatHistoriesAdapter.delete(id); return true; },
});
const customerIntents = new Proxy({}, {
  get: (_, id) => customerIntentsAdapter.getSync(id),
  set: (_, id, val) => { customerIntentsAdapter.setSync(id, val); return true; },
  has: (_, id) => customerIntentsAdapter.has(id),
  deleteProperty: (_, id) => { customerIntentsAdapter.delete(id); return true; },
});

// Armazena últimas respostas da Sofia por ID do usuário (anti-repetição)
const lastResponses = {};

// Armazena resumos de conversas antigas por ID do usuário
const conversationSummaries = {};

// Limite máximo de mensagens no histórico (system prompt + summary + últimas N interações)
const MAX_HISTORY_LENGTH = 14;

// Limiar para comprimir histórico (quando atinge esse nível, resume as mensagens antigas)
const COMPRESS_THRESHOLD = 12;

/**
 * Comprime histórico antigo em um resumo e mantém apenas mensagens recentes.
 * Isso evita que a IA repita argumentos já feitos e reduz tokens.
 */
async function compressAndTrimHistory(userId) {
    const history = chatHistories[userId];
    if (!history || history.length <= MAX_HISTORY_LENGTH) return;

    const systemMessage = history[0];
    // Pegar mensagens antigas (exceto system e as últimas 6 interações)
    const keepRecent = 8; // últimas 8 mensagens (4 trocas)
    const oldMessages = history.slice(1, -(keepRecent));
    const recentMessages = history.slice(-keepRecent);

    if (oldMessages.length < 4) {
        // Pouca coisa para resumir, só faz trim simples
        chatHistories[userId] = [systemMessage, ...recentMessages];
        return;
    }

    try {
        // Gerar resumo compacto das mensagens antigas
        const summaryPrompt = oldMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${(m.content || '').substring(0, 150)}`)
            .join('\n');

        const summaryResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Resuma esta conversa em 3-4 frases objetivas. Foque em: nome do cliente, o que ele quer, objeções levantadas, o que já foi explicado, e em que ponto a conversa parou. Seja direto." },
                { role: "user", content: summaryPrompt }
            ],
            temperature: 0.3,
            max_tokens: 150
        });

        const summary = summaryResponse.choices[0]?.message?.content || '';
        conversationSummaries[userId] = summary;

        // Reconstruir histórico: system + resumo como contexto + mensagens recentes
        chatHistories[userId] = [
            systemMessage,
            { role: "user", content: `[RESUMO DA CONVERSA ANTERIOR]\n${summary}\n[FIM DO RESUMO]` },
            { role: "assistant", content: "Entendi, vou continuar a conversa a partir daqui." },
            ...recentMessages
        ];

        console.log(`🧠 Histórico comprimido para ${userId}: resumo gerado (${oldMessages.length} msgs antigas → 1 resumo)`);
    } catch (error) {
        // Fallback: trim simples se a compressão falhar
        chatHistories[userId] = [systemMessage, ...recentMessages];
        console.log(`🧹 Histórico podado (fallback) para ${userId}: ${history.length} → ${chatHistories[userId].length}`);
    }
}

/**
 * Registra resposta da Sofia para anti-repetição (mantém últimas 5)
 */
function trackResponse(userId, response) {
    if (!lastResponses[userId]) {
        lastResponses[userId] = [];
    }
    lastResponses[userId].push(response);
    if (lastResponses[userId].length > 5) {
        lastResponses[userId].shift();
    }
}

/**
 * Gera contexto anti-repetição baseado nas últimas respostas
 */
function getAntiRepetitionContext(userId) {
    const recent = lastResponses[userId];
    if (!recent || recent.length < 2) return '';

    const recentSnippets = recent
        .slice(-3)
        .map(r => r.substring(0, 80))
        .join(' | ');

    return `\n[ANTI-REPETIÇÃO] Suas últimas respostas incluíram: "${recentSnippets}". NÃO repita esses mesmos pontos ou frases. Aborde de um ângulo completamente diferente.`;
}

function enforceSingleQuestion(text) {
    const normalized = String(text || '').trim();
    const questions = normalized.match(/\?/g) || [];

    if (questions.length <= 1) {
        return normalized;
    }

    const firstQuestionEnd = normalized.indexOf('?') + 1;
    const head = normalized.slice(0, firstQuestionEnd).trim();
    const tail = normalized.slice(firstQuestionEnd).replace(/\?/g, '.').trim();

    return tail ? `${head} ${tail}`.trim() : head;
}

function readLeadField(lead, field) {
    if (!lead || typeof lead !== 'object') return null;
    if (field in lead && lead[field] !== undefined && lead[field] !== null && lead[field] !== '') {
        return lead[field];
    }
    if (lead.qualificacao && typeof lead.qualificacao === 'object') {
        if (field in lead.qualificacao && lead.qualificacao[field] !== undefined && lead.qualificacao[field] !== null && lead.qualificacao[field] !== '') {
            return lead.qualificacao[field];
        }
        if (field === 'descricao_tratamento_anterior' && lead.qualificacao.descricao_tratamento) {
            return lead.qualificacao.descricao_tratamento;
        }
        if (field === 'urgencia_percebida' && lead.qualificacao.urgencia) {
            return lead.qualificacao.urgencia;
        }
        if (field === 'objecao_detectada' && lead.qualificacao.objecao_atual) {
            return lead.qualificacao.objecao_atual;
        }
    }
    if (lead.data && typeof lead.data === 'object' && field in lead.data) {
        return lead.data[field];
    }
    return null;
}

function countAssistantQuestions(conversationHistory = []) {
    return (conversationHistory || [])
        .filter((message) => message.role === 'assistant')
        .reduce((count, message) => count + ((String(message.content || '').match(/\?/g) || []).length), 0);
}

function countSchedulingAttempts(lead = {}, conversationHistory = []) {
    const explicitValue = Number(lead.tentativas_agendamento);
    if (Number.isFinite(explicitValue) && explicitValue >= 0) {
        return explicitValue;
    }

    const inferred = (conversationHistory || [])
        .filter((message) => message.role === 'assistant')
        .filter((message) => /agend|agenda|hor[aá]rio|horarios|avalia[cç][aã]o/i.test(String(message.content || '')))
        .length;

    if (lead.agendamento_robusto?.stage || lead.etapa_funil?.startsWith('agendado_')) {
        return Math.max(inferred, 1);
    }

    return inferred;
}

function detectConversationPhase(lead = {}, conversationHistory = []) {
    const messages = conversationHistory || [];
    const userMessages = messages.filter((message) => message.role === 'user');

    if (userMessages.length === 0) return 'phase_1_intention';

    const hasIntention = Boolean(readLeadField(lead, 'interesse_principal'));
    const treatmentFlag = readLeadField(lead, 'tratamento_anterior');
    const explicitUrgency = lead.qualificacao?.urgencia;
    const hasContext = Boolean(
        readLeadField(lead, 'tempo_problema')
        || typeof treatmentFlag === 'boolean'
        || readLeadField(lead, 'sintoma_adicional')
        || (explicitUrgency && explicitUrgency !== 'nao_identificada')
    );

    if (!hasIntention) return 'phase_1_intention';
    if (!hasContext && countAssistantQuestions(messages) < 3) return 'phase_2_deepening';
    return 'phase_3_transition';
}

function formatLeadName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed || /^cliente$/i.test(trimmed)) return 'você';
    return trimmed;
}

function formatBooleanValue(value) {
    if (typeof value === 'boolean') {
        return value ? 'sim' : 'não';
    }

    return 'não informado';
}

function formatPhaseLabel(phase) {
    const labels = {
        phase_1_intention: 'phase_1_intention (fase 1: identificar intenção)',
        phase_2_deepening: 'phase_2_deepening (fase 2: aprofundar contexto)',
        phase_3_transition: 'phase_3_transition (fase 3: transição para próximo passo)',
    };

    return labels[phase] || phase || 'phase_1_intention';
}

function buildLeadContext(lead = {}, conversationHistory = []) {
    const phase = detectConversationPhase(lead, conversationHistory);
    const treatmentFlag = readLeadField(lead, 'tratamento_anterior');
    const objection = readLeadField(lead, 'objecao_atual')
        || readLeadField(lead, 'objecao_detectada')
        || lead.motivo_recusa
        || 'nenhuma';
    const leadScore = Number(lead.lead_score ?? lead.score ?? 0) || 0;

    return [
        '## CONTEXTO DO LEAD ATUAL',
        `- Nome: ${formatLeadName(lead.nome || lead.data?.nome)}`,
        `- Interesse identificado: ${readLeadField(lead, 'interesse_principal') || 'ainda não identificado'}`,
        `- Tempo do problema: ${readLeadField(lead, 'tempo_problema') || 'não informado'}`,
        `- Já fez tratamento antes: ${formatBooleanValue(treatmentFlag)}`,
        `- Nível de qualificação: ${lead.nivel_qualificacao || lead.qualificacao?.nivel_qualificacao || 'novo'}`,
        `- Temperatura do lead: ${lead.temperatura || 'cold'}`,
        `- Score do lead: ${leadScore}`,
        `- Fase da conversa: ${formatPhaseLabel(phase)}`,
        `- Objeção atual: ${objection}`,
        `- Tentativas de agendamento nesta conversa: ${countSchedulingAttempts(lead, conversationHistory)}`,
    ].join('\n');
}

function buildInitialChatHistory(systemContent, leadData = null) {
    const history = [{ role: 'system', content: systemContent }];
    const restoredMessages = (leadData?.contexto_conversa || [])
        .slice(-10)
        .filter((message) => message && typeof message.content === 'string' && message.content.trim().length > 0)
        .map((message) => ({
            role: message.role,
            content: message.content,
        }));

    if (restoredMessages.length > 0) {
        history.push(...restoredMessages);
    }

    return history;
}

/**
 * Analisa a intenção e sentimento do cliente a partir do texto
 * Retorna um objeto com análise detalhada
 */
function analyzeCustomerIntent(userMessage) {
    const message = userMessage.toLowerCase();
    
    // Palavras-chave para detectar escalação para humano
    const escalationKeywords = [
        'falar com uma pessoa', 'falar com humano', 'atendente', 'gerente',
        'supervisor', 'responsável', 'conversar com um humano', 'quero falar com',
        'preciso falar com', 'pode me passar', 'me coloca', 'quero ser conectado',
        'em que posso falar', 'qual o telefone', 'me transfere', 'consultório',
        'agendar de verdade', 'confirmar agendamento'
    ];

    // Palavras-chave para frustração/impaciência
    const frustrationKeywords = [
        'chato', 'cansado', 'chateado', 'bravo', 'irritado', 'raiva', 'pior',
        'nunca', 'jamais', 'nada funciona', 'desisto', 'não adianta', 'problema',
        'impossível', 'não funciona', 'pior ainda', 'que decepção'
    ];

    // Palavras-chave de urgência
    const urgencyKeywords = [
        'urgente', 'rápido', 'hoje', 'agora', 'logo', 'pressa', 'amanhã',
        'preciso', 'maximo de tempo', 'asap', 'com urgência'
    ];

    // Detectar demandas específicas
    const hasEscalationIntent = escalationKeywords.some(keyword => message.includes(keyword));
    const frustrationLevel = frustrationKeywords.filter(keyword => message.includes(keyword)).length;
    const urgencyLevel = urgencyKeywords.filter(keyword => message.includes(keyword)).length;
    
    // Detectar se é pergunta específica (começa com ?, tem dúvida clara)
    const hasSpecificDemand = message.includes('?') || 
                              message.includes('como') || 
                              message.includes('quanto') ||
                              message.includes('qual') ||
                              message.includes('quando') ||
                              message.includes('onde');

    // Qualidade da mensagem (curta vs longa indica engajamento)
    const messageLength = userMessage.split(' ').length;
    const isEngaged = messageLength > 3;

    // Determinar prioridade
    let priority = 'normal';
    if (frustrationLevel > 0 && urgencyLevel > 0) priority = 'high';
    else if (hasEscalationIntent) priority = 'escalation';
    else if (frustrationLevel > 1) priority = 'high';
    else if (hasSpecificDemand && isEngaged) priority = 'focused';

    return {
        hasEscalationIntent,
        frustrationLevel,
        urgencyLevel,
        hasSpecificDemand,
        isEngaged,
        priority,
        messageLength
    };
}

/**
 * Determina se a conversa deve ser escalada para um humano
 */
function shouldEscalateToHuman(userId, userMessage) {
    const intent = analyzeCustomerIntent(userMessage);
    
    // Armazenar intent para referência futura
    customerIntents[userId] = intent;

    // Escalação imediata se cliente pede explicitamente por humano
    if (intent.hasEscalationIntent) {
        return {
            shouldEscalate: true,
            reason: 'Cliente solicitou falar com um humano',
            priority: 'high'
        };
    }

    // Escalação se muito frustrado + urgente
    if (intent.frustrationLevel > 2 && intent.urgencyLevel > 1) {
        return {
            shouldEscalate: true,
            reason: 'Cliente muito frustrado e com urgência',
            priority: 'critical'
        };
    }

    // Escalação se cliente tem demanda específica muito clara após várias mensagens
    const conversationLength = chatHistories[userId]?.length || 0;
    if (intent.hasSpecificDemand && conversationLength > 6 && intent.frustrationLevel > 0) {
        return {
            shouldEscalate: true,
            reason: 'Cliente com demanda específica não respondida satisfatoriamente',
            priority: 'high'
        };
    }

    return { shouldEscalate: false, reason: null, priority: null };
}

const CALENDAR_ASSISTANT_MODE = true;

const systemPrompt = `Você é a Sofia, assistente virtual especializada em saúde capilar de uma clínica de tricologia.

## SUA MISSÃO
Ajude pessoas que chegam com dúvidas ou problemas capilares a:
1. Se sentirem acolhidas e compreendidas.
2. Entender que o próximo passo inteligente é uma avaliação profissional.
3. Agendar essa avaliação de forma natural, sem pressão.

## IDENTIDADE E PERSONALIDADE
- Nome: Sofia.
- Papel: assistente especialista em saúde capilar.
- Tom: caloroso, claro e consultivo.
- Você nunca soa robótica e nunca soa como vendedora agressiva.
- Você responde rápido, mas nunca atropela o ritmo do lead.
- Você é humana: ignora erros de digitação e foca no conteúdo.
- Você é honesta: não promete resultado sem avaliação.
- Você é direta: sem enrolação, mas sem pressa.

## COMO INICIAR UMA CONVERSA
- Quando alguém entrar em contato pela primeira vez, sempre comece com uma saudação calorosa e UMA pergunta de intenção.
- Nunca comece com "Quer agendar?" e nunca abra com lista de serviços.
- Modelo ideal: "Oi, tudo bem? Me conta: você está buscando ajuda para queda, crescimento, caspa ou outro incômodo no couro cabeludo?"
- A primeira resposta deve ser curta, acolhedora e com uma única pergunta aberta.

## COMO CONDUZIR A QUALIFICAÇÃO
- Após a resposta inicial, aprofunde de forma natural.
- Faça UMA pergunta por mensagem.
- Nunca faça mais de 3 perguntas de qualificação antes de oferecer o próximo passo.
- Pergunte apenas o que falta para entender o caso: tempo do problema, tratamento anterior, sintomas adicionais ou impacto do problema.
- Mostre escuta antes de perguntar de novo.

## QUANDO E COMO OFERECER AGENDAMENTO
- Ofereça agendamento apenas quando houver intenção clara e algum contexto real do caso.
- A transição deve seguir esta lógica: acolhimento do problema + explicação do próximo passo + pergunta suave de confirmação.
- Fórmula recomendada: "Pelo que você me contou, [acolhimento do problema]. O próximo passo mais indicado é uma avaliação capilar para entender melhor o seu caso. Quer que eu veja os horários disponíveis?"
- Variações aceitas: "Faz todo sentido você buscar ajuda para isso. Uma avaliação seria o caminho ideal. Posso verificar a agenda?" e "Esse tipo de caso merece uma olhada mais detalhada. Posso te ajudar a agendar uma avaliação?"
- Nunca use linguagem de pressão, escassez artificial, promoção forçada ou urgência inventada.
- Nunca faça mais de 2 tentativas de agendamento na mesma conversa.

## SE O LEAD NÃO ESTIVER PRONTO
- Se o lead hesitar, disser "vou pensar", "depois" ou "não sei", não repita a oferta imediatamente.
- Responda com empatia: "Faz sentido. Se quiser pensar, sem problema."
- Ofereça informação útil: explique como funciona a avaliação se isso ajudar.
- Deixe a porta aberta: "Quando estiver pronto, estarei aqui."

## SE O LEAD TIVER UMA OBJEÇÃO
- Preço: explique que a avaliação é o primeiro passo e que a pessoa não precisa se comprometer com um plano antes de entender o caso.
- Tempo: valide a limitação e ofereça ver horários em um período mais conveniente.
- Desconfiança: explique o processo da avaliação com clareza, passo a passo e sem compromisso.
- Trate a objeção antes de avançar.

## LIMITES DO QUE VOCÊ PODE FAZER
- Nunca dê diagnóstico fechado.
- Em vez disso, diga que pode haver diferentes causas e que a avaliação identifica o que está acontecendo.
- Nunca prometa resultados específicos.
- Nunca peça dados pessoais sem necessidade.
- Só peça nome e preferência de horário quando estiver realmente confirmando agendamento.

## FORMATO DAS MENSAGENS
- Primeiras mensagens: curtas, de 1 a 2 linhas.
- Mensagens de transição: no máximo 4 linhas.
- Confirmações de agendamento podem ser mais completas.
- Use emojis com moderação. Exemplos suficientes: 😊 📅 ✅.
- Nunca use letras maiúsculas em excesso nem exclamações em excesso.

## FLUXO DE DECISÃO
- Fase 1: se a intenção ainda não estiver clara, descubra a intenção com uma pergunta simples.
- Fase 2: se já houver intenção, aprofunde com 1 a 2 perguntas para captar contexto.
- Fase 3: se houver intenção e contexto, transicione para agendamento de forma natural.
- Se houver objeção, trate a objeção antes de avançar.
- Se o lead não estiver pronto, não pressione.
- Se o lead sumir, follow-up e remarketing acontecem fora da conversa, automaticamente.

## USO DAS FERRAMENTAS
- Você tem acesso a ferramentas de calendário para consultar ou alterar eventos reais.
- Use essas ferramentas apenas quando o lead já estiver pronto para falar de agenda ou quando precisar confirmar disponibilidade real.
- Antes de criar, editar ou deletar um evento, confirme explicitamente os detalhes finais.
- Nunca invente horários, disponibilidade, eventos ou confirmações.
- Se houver conflito, explique com clareza e ofereça alternativas.

## REGRA DE OURO
A Sofia não conduz pela pressão, conduz pela clareza.
Ela entende primeiro, organiza a necessidade e só então oferece o agendamento como a saída mais natural da conversa.

Responda sempre em português brasileiro.`;
async function getSofiaResponse(userId, userMessage, audioContext = null) {
    // ===== A/B TESTING — atribuir variante =====
    const abVariant = abTesting.assignVariant(userId);
    const abOverrides = abTesting.getOverrides(userId);
    const abPatch = abTesting.getPromptPatch(userId);
    const effectivePrompt = abPatch ? systemPrompt + '\n' + abPatch : systemPrompt;

    // ===== CONTEXTO FRIO — detectar gap > COLD_CONTEXT_HOURS ===== 
    const coldPrompt = await injetarContextoFrio(effectivePrompt, userId);

    let leadData = null;
    try {
        leadData = await leadMemory.getOrCreateLead(userId);
    } catch (error) {
        console.warn(`⚠️ leadMemory indisponível para ${userId}: ${error.message}`);
        leadData = null;
    }

    // Inicializa o histórico se não existir
    if (!chatHistories[userId]) {
        console.log(`📝 Iniciando novo histórico para ${userId} [A/B: ${abVariant}]`);
        chatHistories[userId] = buildInitialChatHistory(coldPrompt, leadData);

        // Bug 2 — Hidratação: restaura histórico do banco após restart no Railway
        try {
            const hist = (leadData?.contexto_conversa || []).slice(-10);
            if (hist.length > 0) {
                console.log(`💾 Histórico restaurado do banco para ${userId}: ${hist.length} msgs`);
            }
        } catch (e) {
            console.warn(`⚠️ Hidratação falhou para ${userId}: ${e.message}`);
        }
    } else if (coldPrompt !== effectivePrompt) {
        // Sessão já existe mas retomou após gap longo — atualizar system message
        chatHistories[userId][0] = { role: "system", content: coldPrompt };
        console.log(`🥶 [ai.js] Contexto frio injetado para ${userId}`);
    }

    // ===== MEMÓRIA DO CLIENTE (compacta) =====
    const clientMem = clientMemory.getClientMemory(userId);
    const memoryContext = clientMemory.createMemoryContext(userId);
    const leadConversationHistory = leadData?.contexto_conversa || [];
    const leadContext = leadData ? buildLeadContext(leadData, leadConversationHistory) : '';
    const hasExplicitLeadContext = typeof audioContext === 'string'
        && (audioContext.includes('[CONTEXTO DO LEAD]') || audioContext.includes('## CONTEXTO DO LEAD ATUAL'));
    
    console.log(`👤 Cliente: ${clientMem.personal.name || leadData?.nome || 'Desconhecido'}`);

    // ===== RAG — Buscar APENAS se a mensagem pede informação =====
    // Mensagens curtas (oi, ok, sim, não) não precisam de RAG
    const msgWords = userMessage.trim().split(/\s+/).length;
    const needsRag = !CALENDAR_ASSISTANT_MODE && (msgWords > 2 || userMessage.includes('?'));
    let ragContext = '';
    
    if (needsRag) {
        console.log(`🔍 RAG ativado (msg com ${msgWords} palavras)`);
        const relevantDocs = await knowledgeBase.retrieveRelevantDocuments(userMessage, 2);
        ragContext = knowledgeBase.formatDocumentsAsContext(relevantDocs);
    } else {
        console.log(`⏭️ RAG ignorado (msg curta: "${userMessage}")`);
    }

    // ===== ANÁLISE DE INTENÇÃO =====
    const intent = analyzeCustomerIntent(userMessage);
    console.log(`🔍 Análise de Intenção:`, intent);
    
    if (audioContext) {
        console.log(`🎙️ CONTEXTO DE ÁUDIO DETECTADO`);
    }

    // ===== VERIFICAR ESCALAÇÃO =====
    const escalation = shouldEscalateToHuman(userId, userMessage);
    if (escalation.shouldEscalate) {
        console.log(`🚨 ESCALAÇÃO DETECTADA - Razão: ${escalation.reason} | Prioridade: ${escalation.priority}`);
        
        const escalationMessages = [
            `Entendo! Vou te conectar com nosso time agora. Aguarda um momento 👋`,
            `Tudo bem, te conecto com um atendente. Só um segundo!`,
            `Claro, transferindo você agora...`,
            `Perfeito, conectando com a equipe...`
        ];

        const randomEscalation = escalationMessages[Math.floor(Math.random() * escalationMessages.length)];
        swop.recordError(userId, `ESCALAÇÃO: ${escalation.reason}`, 'ESCALATION_TO_HUMAN');
        return randomEscalation;
    }

    // ===== ANTI-REPETIÇÃO =====
    const antiRepetition = getAntiRepetitionContext(userId);

    // ===== PREPARAR MENSAGEM — Contexto enxuto =====
    const contextParts = [];

    if (leadContext && !hasExplicitLeadContext) {
        contextParts.push(leadContext);
    }
    
    // Memória: apenas se tem info útil (não envia bloco vazio)
    if (memoryContext && memoryContext.trim().length > 20) {
        contextParts.push(memoryContext);
    }
    
    // RAG: apenas se encontrou docs relevantes
    if (ragContext && ragContext.trim().length > 10) {
        contextParts.push(ragContext);
    }
    
    // Áudio: se houver
    if (audioContext) {
        contextParts.push(audioContext);
    }
    
    // Anti-repetição
    if (antiRepetition) {
        contextParts.push(antiRepetition);
    }

    // Montar mensagem final — contexto vai ANTES, mensagem do cliente vai separada e clara
    let fullUserMessage;
    if (contextParts.length > 0) {
        fullUserMessage = contextParts.join('\n') + `\n\nMensagem do cliente: ${userMessage}`;
    } else {
        fullUserMessage = userMessage;
    }

    // Adiciona ao histórico
    chatHistories[userId].push({ 
        role: "user", 
        content: fullUserMessage,
        _ts: Date.now()
    });
    
    console.log(`💬 Processando (contextos: ${contextParts.length}, RAG: ${needsRag})...`);

    try {
        const requestStartTime = Date.now();

        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY não está configurada no .env');
        }

        // ===== CHAMADA PRINCIPAL — Temperatura e tokens otimizados =====
        const aiTemperature = abOverrides.temperature || 0.6;
        const aiMaxTokens = abOverrides.maxTokens || 130;
        
        console.log(`🔄 OpenAI API (temp=${aiTemperature}, max_tokens=${aiMaxTokens})...`);

        const response = await selfHealing.execute(
            () => openai.chat.completions.create({
                model: "gpt-4o",
                messages: chatHistories[userId],
                temperature: aiTemperature,
                max_tokens: aiMaxTokens,
                tools: functionCalling.getToolSchemas(),
                tool_choice: 'auto'
            }),
            (ctx) => {
                const adj = ctx.adjustments || {};
                return openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: chatHistories[userId],
                    temperature: adj.temperature || aiTemperature,
                    max_tokens: adj.max_tokens || aiMaxTokens,
                    tools: functionCalling.getToolSchemas(),
                    tool_choice: 'auto'
                });
            },
            { userId, operation: 'openai_chat' }
        );

        const requestLatency = Date.now() - requestStartTime;
        console.log(`⚡ OpenAI respondeu em ${requestLatency}ms`);

        if (!response || !response.choices || !response.choices[0]) {
            throw new Error('Resposta inválida da OpenAI');
        }

        const choice = response.choices[0];
        let sofiaMessage = '';
        let functionCalls = [];

        // ===== PROCESSAR TOOL CALLS SE HOUVER =====
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            console.log(`🔧 Funções chamadas pela IA:`);
            
            // Adicionar a mensagem da IA ao histórico
            chatHistories[userId].push({
                role: "assistant",
                content: choice.message.content || '',
                tool_calls: choice.message.tool_calls
            });

            // Executar cada função chamada
            for (const toolCall of choice.message.tool_calls) {
                console.log(`   - ${toolCall.function.name}`);
                
                let functionResult;
                try {
                    const args = JSON.parse(toolCall.function.arguments);
                    functionResult = await functionCalling.executeFunction(toolCall.function.name, args);
                    console.log(`   ✅ Resultado:`, typeof functionResult === 'object' ? JSON.stringify(functionResult).substring(0, 100) : functionResult);
                } catch (error) {
                    functionResult = { error: error.message };
                    console.log(`   ❌ Erro:`, error.message);
                }

                // Adicionar resultado ao histórico
                chatHistories[userId].push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(functionResult)
                });

                functionCalls.push({
                    name: toolCall.function.name,
                    result: functionResult
                });
            }

            // ===== CHAMADA FINAL PARA GERAR RESPOSTA =====
            console.log(`🔄 Gerando resposta final com resultados das funções...`);
            
            const finalResponse = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: chatHistories[userId],
                temperature: aiTemperature,
                max_tokens: aiMaxTokens
            });

            if (!finalResponse.choices[0]?.message?.content) {
                throw new Error('Resposta final inválida');
            }

            sofiaMessage = enforceSingleQuestion(finalResponse.choices[0].message.content);
            
            // Adicionar ao histórico
            chatHistories[userId].push({
                role: "assistant",
                content: sofiaMessage
            });

        } else {
            // Resposta normal sem function calls
            sofiaMessage = enforceSingleQuestion(choice.message.content);
            chatHistories[userId].push({ role: "assistant", content: sofiaMessage });
        }

        // ===== COMPRESSÃO INTELIGENTE DO HISTÓRICO =====
        await compressAndTrimHistory(userId);

        // ===== ANTI-REPETIÇÃO: Registrar resposta =====
        trackResponse(userId, sofiaMessage);

        // Bug 2 — Persistência: salva cada mensagem no banco em background
        db.insertConversationMessage(userId, 'user', userMessage);
        db.insertConversationMessage(userId, 'assistant', sofiaMessage);

        // ===== ATUALIZAR MEMÓRIA DO CLIENTE =====
        console.log(`📝 Atualizando memória do cliente...`);
        
        // Registrar tópicos discutidos
        const lowerMsg = userMessage.toLowerCase();
        if (lowerMsg.includes('prec') || lowerMsg.includes('cust') || lowerMsg.includes('valor') || lowerMsg.includes('quanto')) {
            clientMemory.recordTopicDiscussed(userId, 'preços_custos');
        }
        if (lowerMsg.includes('calvic') || lowerMsg.includes('alopec') || lowerMsg.includes('queda') || lowerMsg.includes('cabelo')) {
            clientMemory.recordTopicDiscussed(userId, 'saúde_capilar');
        }
        if (lowerMsg.includes('mesoterap') || lowerMsg.includes('procedimento') || lowerMsg.includes('como funciona')) {
            clientMemory.recordTopicDiscussed(userId, 'mesoterapia_explicação');
        }
        if (lowerMsg.includes('agend') || lowerMsg.includes('horár') || lowerMsg.includes('marc')) {
            clientMemory.recordTopicDiscussed(userId, 'agendamento');
        }
        if (lowerMsg.includes('dói') || lowerMsg.includes('dor') || lowerMsg.includes('agulha') || lowerMsg.includes('medo')) {
            clientMemory.recordTopicDiscussed(userId, 'medo_dor');
        }
        
        // Registrar perguntas
        if (userMessage.includes('?')) {
            clientMemory.recordQuestion(userId, userMessage);
        }

        // Atualizar sentimento baseado na intenção
        const sentimentMap = {
            normal: 'neutral',
            focused: 'neutral',
            high: 'positive',
            escalation: 'negative'
        };
        if (sentimentMap[intent.priority]) {
            clientMemory.updateSentiment(userId, sentimentMap[intent.priority]);
        }

        // ===== LOGS FINAIS =====
        console.log(`✅ Resposta gerada com sucesso`);
        console.log(`📤 Sofia: "${sofiaMessage.substring(0, 100)}..."`);
        console.log(`🔧 Funções chamadas: ${functionCalls.length}`);
        console.log(`📊 Prioridade: ${intent.priority}`);

        return sofiaMessage;

    } catch (error) {
        const errorMsg = error.message || 'Unknown error';
        const errorType = error.code || error.type || 'API_ERROR';

        console.error(`❌ ERRO CRÍTICO [${errorType}]: ${errorMsg}`);
        console.error(`📌 Stack: ${error.stack}`);

        swop.recordError(userId, errorMsg, errorType);

        // Verificar se é erro de histórico muito longo e tentar corrigir
        const healing = await selfHealing.analyze(error, null, { userId });
        if (healing.recovered && healing.result?.action === 'trim_history' && chatHistories[userId]) {
            const systemMsg = chatHistories[userId][0];
            const keep = healing.result.keepMessages || 10;
            chatHistories[userId] = [systemMsg, ...chatHistories[userId].slice(-keep)];
            console.log(`🔧 Histórico podado automaticamente para ${userId}`);
            return "Desculpa, precisei reorganizar minha memória aqui. Pode repetir, por favor?";
        }

        return "Desculpa! Tive um problema com minha conexão aqui. Pode tentar novamente em um momento?";
    }
}

// Limpa históricos de usuários inativos há mais de 2 horas
setInterval(() => {
    const now = Date.now();
    const TTL = 2 * 60 * 60 * 1000;
    for (const userId of Object.keys(chatHistories)) {
        const last = chatHistories[userId]?.slice(-1)[0]?._ts || 0;
        if (now - last > TTL) {
            delete chatHistories[userId];
            delete lastResponses[userId];
            delete customerIntents[userId];
            delete conversationSummaries[userId];
        }
    }
}, 30 * 60 * 1000);

module.exports = {
    getSofiaResponse,
    analyzeCustomerIntent,
    shouldEscalateToHuman,
    detectConversationPhase,
    buildLeadContext,
    buildInitialChatHistory,
    systemPrompt,
};
