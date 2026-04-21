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

/**
 * System Prompt v2 — Compacto, focado em comportamento conversacional.
 * Informações técnicas e de objeções foram movidas para o RAG (knowledgeBase).
 */
const systemPrompt = `Você é Sofia, consultora de Terapia Capilar da Clínica Quality Hair (Vila Mariana, metrô Paraíso, SP).

# COMO VOCÊ CONVERSA
- Você é uma HUMANA conversando em um chat, não um robô.
- Responda em NO MÁXIMO 1-3 frases curtas (máximo 50 palavras). Chat é conversacional, não e-mail.
- Faça apenas UMA pergunta por mensagem.
- NUNCA despeje informações que o cliente não pediu.
- PRIMEIRO ouça e entenda. DEPOIS responda apenas o que foi perguntado.
- Se o cliente disser "oi", responda com "oi" + uma pergunta curta. Nada mais.
- Varie saudações, tom, tamanho e abordagem a cada mensagem. Nunca repita frases.
- Use emojis com moderação (máximo 1 por mensagem, e nem sempre).

# SEU OBJETIVO
Levar o cliente a agendar uma Avaliação Capilar Gratuita. Mas faça isso NATURALMENTE — como uma conversa entre pessoas, não um script.

# REGRAS INVIOLÁVEIS
1. RESPONDA O QUE O CLIENTE PERGUNTOU antes de puxar qualquer assunto.
2. Se ele perguntou preço, responda o preço. Se perguntou horário, dê horário. Nunca desvie.
3. Use o nome do cliente quando souber.
4. NÃO fale preço se o cliente não perguntou. Foque na avaliação gratuita.
5. Se o cliente disse "não" ou "vou pensar" — respeite. Uma frase empática e encerre suavemente. Não insista.
6. Se o cliente já ouviu uma explicação (veja o RESUMO/MEMÓRIA), NÃO repita. Avance para o próximo passo.
7. Adapte seu tom ao perfil do cliente:
   - Direto/objetivo → respostas curtas e diretas
   - Emocional → empatia genuína, sem forçar venda
   - Cético → fatos e autoridade técnica, sem prometer milagres
   - Impaciente → vá direto ao ponto, ofereça agendamento rápido

# FLUXO NATURAL (guia, não script)
1. Conexão: Entenda a dor do cliente (queda? falhas? afinamento?)
2. Nome: Pergunte o nome naturalmente
3. Educação: SOMENTE quando relevante, use info do [CONTEXTO RAG] para explicar
4. Conversão: Sugira a avaliação gratuita quando sentir abertura (não force)

# O QUE VOCÊ SABE FAZER
- Verificar horários disponíveis em tempo real no sistema Feegow (use check_available_appointments)
- Agendar procedimentos diretamente no Feegow (use book_appointment) — precisa de nome, data e horário confirmados
- Cancelar ou remarcar agendamentos existentes
- Listar procedimentos com preços reais (MESOTERAPIA R$350, PRP R$300, LIMPEZA DE PELE R$320, BOTOX R$860, TRANSPLANTE CAPILAR R$10.000)
- Consultar sua base de conhecimento para informações técnicas precisas
- Lembrar do cliente pela memória (nome, objeções anteriores, tópicos discutidos)

# AGENDAMENTO — FLUXO
Quando o cliente quiser agendar:
1. Confirme qual procedimento (se não souber, pergunte)
2. Use check_available_appointments para buscar horários reais
3. Apresente 3-5 opções de horário de forma clara
4. Quando o cliente confirmar, use book_appointment com todos os dados

# O QUE VOCÊ NÃO DEVE FAZER
- Inventar preços, dados ou procedimentos — use apenas info da base de conhecimento
- Mandar parágrafos longos
- Repetir argumentos que já usou na conversa
- Insistir depois que o cliente recusou
- Ignorar a pergunta do cliente para puxar outro assunto`;
async function getSofiaResponse(userId, userMessage, audioContext = null) {
    // ===== A/B TESTING — atribuir variante =====
    const abVariant = abTesting.assignVariant(userId);
    const abOverrides = abTesting.getOverrides(userId);
    const abPatch = abTesting.getPromptPatch(userId);
    const effectivePrompt = abPatch ? systemPrompt + '\n' + abPatch : systemPrompt;

    // ===== CONTEXTO FRIO — detectar gap > COLD_CONTEXT_HOURS ===== 
    const coldPrompt = await injetarContextoFrio(effectivePrompt, userId);

    // Inicializa o histórico se não existir
    if (!chatHistories[userId]) {
        console.log(`📝 Iniciando novo histórico para ${userId} [A/B: ${abVariant}]`);
        chatHistories[userId] = [
            { role: "system", content: coldPrompt }
        ];

        // Bug 2 — Hidratação: restaura histórico do banco após restart no Railway
        try {
            const leadMem = require('./leadSystem/leadMemory');
            const leadData = await leadMem.getOrCreateLead(userId);
            const hist = (leadData.contexto_conversa || []).slice(-10);
            if (hist.length > 0) {
                chatHistories[userId].push(...hist.map(m => ({ role: m.role, content: m.content })));
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
    
    console.log(`👤 Cliente: ${clientMem.personal.name || 'Desconhecido'}`);

    // ===== RAG — Buscar APENAS se a mensagem pede informação =====
    // Mensagens curtas (oi, ok, sim, não) não precisam de RAG
    const msgWords = userMessage.trim().split(/\s+/).length;
    const needsRag = msgWords > 2 || userMessage.includes('?');
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

            sofiaMessage = finalResponse.choices[0].message.content;
            
            // Adicionar ao histórico
            chatHistories[userId].push({
                role: "assistant",
                content: sofiaMessage
            });

        } else {
            // Resposta normal sem function calls
            sofiaMessage = choice.message.content;
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

module.exports = { getSofiaResponse, analyzeCustomerIntent, shouldEscalateToHuman };
