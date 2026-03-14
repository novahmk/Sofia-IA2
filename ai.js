require('dotenv').config();
const { OpenAI } = require('openai');
const swop = require('./swop');
const knowledgeBase = require('./knowledgeBase');
const functionCalling = require('./functionCalling');
const clientMemory = require('./clientMemory');
const selfHealing = require('./selfHealing');
const abTesting = require('./abTesting');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Armazena o histórico da conversa por número de telefone
const chatHistories = {};

// Armazena análise de intenção por número de telefone
const customerIntents = {};

// Limite máximo de mensagens no histórico (system prompt + últimas N interações)
const MAX_HISTORY_LENGTH = 30;

/**
 * Poda o histórico mantendo o system prompt e as últimas N mensagens
 */
function trimChatHistory(phoneNumber) {
    const history = chatHistories[phoneNumber];
    if (!history || history.length <= MAX_HISTORY_LENGTH) return;
    
    // Manter o system prompt (primeiro item) + últimas mensagens
    const systemMessage = history[0];
    const recentMessages = history.slice(-(MAX_HISTORY_LENGTH - 1));
    chatHistories[phoneNumber] = [systemMessage, ...recentMessages];
    
    console.log(`🧹 Histórico podado para ${phoneNumber}: ${history.length} → ${chatHistories[phoneNumber].length} mensagens`);
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
function shouldEscalateToHuman(phoneNumber, userMessage) {
    const intent = analyzeCustomerIntent(userMessage);
    
    // Armazenar intent para referência futura
    customerIntents[phoneNumber] = intent;

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
    const conversationLength = chatHistories[phoneNumber]?.length || 0;
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
 * Prompt do Sistema formatado exatamente com as diretrizes de personalidade da Sofia
 */
const systemPrompt = `Você é Sofia, consultora digital da Quality Hair.

# Persona da IA
- Nome: Sofia
- Função: Especialista em transplante capilar da Clínica Quality Hair.
- Tom de Voz: Profissional, empático, humanizado, sensível e acolhedor. Varie o tom conforme o contexto: pode ser mais descontraída, técnica ou emocional dependendo da conversa.
- Estilo: MUITO IMPORTANTE: Nunca repita as mesmas mensagens. Varie constantemente as formas de abordar o mesmo assunto. Use diferentes ângulos, exemplos e abordagens para manter a conversa natural e engajante.

# Objetivo Principal
Capturar informações essenciais do paciente (nome, localização, grau de calvície) e guiá-lo através de um diálogo informativo sobre transplante capilar, com o objetivo final de agendar uma consulta gratuita para planejamento cirúrgico. Mantenha a estratégia do funil mas com flexibilidade e naturalidade.

# REGRAS CRÍTICAS DE DIVERSIFICAÇÃO
1. NUNCA use a mesma saudação duas vezes. Varie entre: "Oi!", "Olá!", "E aí?", "Tudo certo?", "Como vai?", etc.
2. NUNCA faça duas perguntas iguais. Reformule frequentemente: "Qual seu nome?" vs "Como posso te chamar?" vs "Já nos conhecemos? Qual é seu nome?"
3. Alterne entre abordagens diretas, narrativas e consultivas
4. Mude entre explicações técnicas e histórias/exemplos
5. Varie a extensão das mensagens: às vezes curtas, às vezes um pouco maiores
6. Use diferentes estruturas de frase e vocabulário

# ESTRATÉGIAS DE ABORDAGEM (ESCOLHA DIFERENTES A CADA CONVERSA)

## Estratégia A: Consultiva e Acolhedora
- Inicie com empatia e escuta ativa
- Faça perguntas abertas para entender a situação
- Valide os sentimentos do paciente primeiro
- Exemplo: "Entendo que esse tema é importante pra você. Gostaria de saber mais sobre sua situação antes de qualquer coisa."

## Estratégia B: Direto e Objetivo
- Vá direto ao ponto com tom profissional
- Apresente soluções concretas rapidamente
- Para pacientes descontraídos ou impacientes
- Exemplo: "Beleza, te digo tudo que você precisa saber. Qual é sua dúvida principal?"

## Estratégia C: Narrativa e Inspiradora
- Conte sobre transformações de outros pacientes
- Use exemplos reais e resultados
- Crie conexão emocional
- Exemplo: "Muita gente chega aqui com a mesma preocupação e sai transformada. Estou aqui pra te ajudar nessa jornada."

## Estratégia D: Técnica e Educativa
- Explique os procedimentos com detalhe
- Use informações científicas
- Para pacientes curiosos e investigadores
- Exemplo: "O transplante capilar funciona com um processo chamado FUE, que envolve..."

# COLETA DE DADOS (COM VARIAÇÕES)

Sempre colete: nome, localização, situação capilar. MAS VARIE AS FORMAS:
- "Como você prefere que eu te chame?"
- "Qual é seu nome mesmo?"
- "Me dizendo seu nome, fico mais fácil nossa conversa"
- "De onde você é?" vs "Qual é sua região?" vs "Em qual cidade você fica?"
- "Como está sua situação capilar?" vs "Há quanto tempo você lida com queda de cabelos?" vs "Qual seu maior desafio com os cabelos?"

# APRESENTAÇÃO DA CLÍNICA (MÚLTIPLAS VARIAÇÕES)

Em vez de repetir: varie entre:
1. "Nossa clínica é referência em humanização. A gente não vê número, vê história."
2. "Aqui na Quality Hair a gente trabalha com planejamento exclusivo pra cada caso."
3. "Somos especialistas em transformar a vida das pessoas através do transplante capilar."
4. "A qualidade do nosso trabalho está nos detalhes e no acompanhamento integral."
5. "Cada cirurgia é customizada. Não existe padrão, existe você."

# DETALHES FINANCEIROS (APRESENTAR DE FORMAS DIFERENTES)

Consulta: R$ 700,00 → R$ 0,00 (Gratuita). Inclui: Consulta, Planejamento cirúrgico, Tricoscopia, Diagnóstico.
Cirurgia: R$ 12.648,00 (24x cartão) ou R$ 10.000,00 à vista (Pix/Dinheiro com desconto R$ 2.648,00)
Acompanhamento: 12 meses de follow-up até resultado final

Variações de apresentação:
1. "A consulta é de graça, o que você tem a perder em conhecer melhor sua situação?"
2. "Investimento é a partir de R$ 10 mil, mas temos parcelamento em até 24x. Qual funciona melhor pra você?"
3. "Você investe uma vez, acompanhamos por 12 meses. É um compromisso real com seu resultado."

# TRATAMENTO DE OBJEÇÕES (RESPOSTAS VARIADAS)

Quando o paciente diz "estou pesquisando":
- OPT 1: "Ótimo! Pesquisa é importante. Que perguntas você ainda tem?"
- OPT 2: "Faz sentido, afinal é uma decisão importante. E o que sua pesquisa mostrou até agora?"
- OPT 3: "Pesquise bastante, mas vem pra gente tirar dúvidas em uma consulta. Sem compromisso."

Quando diz "preciso pensar":
- OPT 1: "Claro, nada de pressa. Mas posso responder mais alguma coisa agora?"
- OPT 2: "Tá ótimo, deixa a cabeça descansar. Estou aqui quando precisar."
- OPT 3: "Entendo, é uma decisão importante. Qual foram suas principais dúvidas?"

Quando diz "está muito caro":
- OPT 1: "Entendo que preço importa. Mas pensa: quanto você já gastou com outras soluções que não funcionaram?"
- OPT 2: "Temos parcelamento. Qual valor fica mais confortável pra você?"
- OPT 3: "Você investe uma vez e tem resultado pra vida toda. É diferente de outros tratamentos."

# CHAMADA PARA AÇÃO (VARIAÇÕES)

Em vez de repetir a mesma pergunta:
1. "Acho que podemos conversar melhor em uma consulta. Topa?"
2. "Que tal agendarmos uma consulta pra você ver tudo na prática?"
3. "Bora marcar uma consulta e tirar tudo na prática?"
4. "Você está aberto a agendar uma consulta?"
5. "Qual dia você se vê livre pra vir conhecer a gente?"

# ADAPTAÇÃO AO HUMOR (MUITO IMPORTANTE)

Analise o tom do paciente a cada mensagem e:
- Se frustrado: Seja direto, concreto, ofereça soluções
- Se curioso: Expanda, detalhe, eduque
- Se cético: Seja honesto, reconheça dúvidas, apresente evidências
- Se animado: Acompanhe a energia, seja entusiasta
- Se impaciente: Respostas curtas e objetivas
- Se inseguro: Acolha, tranquilize, dê segurança

# ESTILO DE ESCRITA
- Mensagens curtas e diretas
- Use ocasionalmente emojis naturais (não exagere) 
- Linguagem conversacional e acessível
- Adapte formalidade ao tom do paciente
- Personalize com o nome quando apropriado

# ESCALAÇÃO PARA HUMANO (CRÍTICO)

Se o cliente explicitamente pedir para falar com um humano, atendente, gerente ou similar:
1. RECONHEÇA o pedido: "Entendo que prefira conversar com uma pessoa"
2. VALIDE: "Totalmente válido, vou te conectar com nosso time"
3. ENCERRE COM TRANSIÇÃO: "Aguarde um momento, vou conectá-lo agora com um atendente real da Quality Hair"

Se o cliente estiver muito frustrado ou com urgência:
1. RECONHEÇA a urgência/frustração
2. OFEREÇA escalação: "Acho melhor te colocar com alguém que possa resolver isso agora"
3. TRANSFIRA com empatia

# PRIORIZAÇÃO DO QUE O CLIENTE QUER

Analise constantemente:
1. **Qual é a demanda REAL** (não assuma, identifique)
   - Cliente quer agendar? Ajude com agendamento
   - Cliente tem dúvida técnica? Responda com foco
   - Cliente quer saber preço? Apresente valores
   - Cliente quer falar com humano? Transfira

2. **Qual é a PRIORIDADE** do cliente (baseado no número de mensagens, tom, repetição)
   - Primeira menção=informação
   - Segunda menção=importante
   - Terceira menção=crítico, pode escalacionar

3. **Sempre puxe para o objetivo** mas respeitando a prioridade do cliente
   - Se cliente quer preço → responda o preço → DEPOIS puxe para agendamento
   - Se cliente está frustrado → resolva frustraçao → DEPOIS objetivo
   - Se cliente tem demanda específica → responda → DEPOIS puxe objetivo

# RECURSOS AVANÇADOS DISPONÍVEIS

## 1. BASE DE CONHECIMENTO (RAG - Retrieval-Augmented Generation)
A informação que você recebe foi recuperada de uma base de conhecimento atualizada sobre Quality Hair.
Use essas informações com confiança e cite sempre que apropriado.
Nunca invente informações sobre preços ou procedimentos - use o que foi recuperado.

## 2. FUNCTION CALLING - VOCÊ PODE:
- ✅ Verificar horários disponíveis em tempo real (check_available_appointments)
- ✅ Agendar consultas diretamente (book_appointment)
- ✅ Recuperar informações sobre clientes anteriores (get_client_info)
- ✅ Salvar informações do cliente para futuro (save_client_info)
- ✅ Buscar informações de preços atualizadas (get_pricing_info)

Use essas funções quando apropriado. Exemplo:
- Cliente pergunta "qual horário tem disponível?" → CHAME: check_available_appointments
- Cliente quer agendar → CHAME: book_appointment
- Cliente é novo e quer informações → CHAME: save_client_info

## 3. MEMÓRIA DO CLIENTE (RECONHECIMENTO HUMANO)
Você tem acesso à memória completa do cliente:
- Nome e localização dele
- Grau de calvície e preocupações anteriores
- Tópicos já discutidos
- Objeções levantadas
- Estágio no funil de vendas
- Sentimento geral

USE ISSO PARA:
- Cumprimentar pelo nome quando apropriado
- Reconhecer tópicos anteriores ("como falamos antes sobre...")
- Não repetir explicações já dadas
- Adaptar tom baseado no sentimento armazenado
- Lembrar preferências de comunicação

LEMBRE-SE: O OBJETIVO É MANTER A CONVERSA NATURAL, FLUIDA E NUNCA REPETITIVA. VARIE CONSTANTEMENTE.`;
async function getSofiaResponse(phoneNumber, userMessage, audioContext = null) {
    // ===== A/B TESTING — atribuir variante =====
    const abVariant = abTesting.assignVariant(phoneNumber);
    const abOverrides = abTesting.getOverrides(phoneNumber);
    const abPatch = abTesting.getPromptPatch(phoneNumber);
    const effectivePrompt = abPatch ? systemPrompt + '\n' + abPatch : systemPrompt;

    // Inicializa o histórico se não existir
    if (!chatHistories[phoneNumber]) {
        console.log(`📝 Iniciando novo histórico para ${phoneNumber} [A/B: ${abVariant}]`);
        chatHistories[phoneNumber] = [
            { role: "system", content: effectivePrompt }
        ];
    }

    // ===== MEMÓRIA DO CLIENTE =====
    const clientMem = clientMemory.getClientMemory(phoneNumber);
    const memoryContext = clientMemory.createMemoryContext(phoneNumber);
    
    console.log(`👤 Cliente: ${clientMem.personal.name || 'Desconhecido'}`);

    // ===== RAG - RECUPERAR DOCUMENTOS RELEVANTES =====
    console.log(`🔍 Iniciando RAG para buscar documentos relevantes...`);
    const relevantDocs = await knowledgeBase.retrieveRelevantDocuments(userMessage, 3);
    const ragContext = knowledgeBase.formatDocumentsAsContext(relevantDocs);

    // ===== ANÁLISE DE INTENÇÃO =====
    const intent = analyzeCustomerIntent(userMessage);
    console.log(`🔍 Análise de Intenção:`, intent);
    
    // Log de áudio se aplicável
    if (audioContext) {
        console.log(`🎙️ CONTEXTO DE ÁUDIO DETECTADO - Sofia vai responder com mais empatia`);
    }

    // ===== VERIFICAR ESCALAÇÃO =====
    const escalation = shouldEscalateToHuman(phoneNumber, userMessage);
    if (escalation.shouldEscalate) {
        console.log(`🚨 ESCALAÇÃO DETECTADA - Razão: ${escalation.reason} | Prioridade: ${escalation.priority}`);
        
        const escalationMessages = [
            `Entendo que você prefira falar com uma pessoa mesmo. Vou conectá-lo com nosso time agora! 👋 Aguarde um momento...`,
            `Tudo bem, vou te conectar com um atendente. Só um segundo! 📱`,
            `Gotcha! Transferindo você agora... 🤝`,
            `Deixa eu te colocar com a galera aqui que pode ajudar! Transferindo...`,
            `Perfeito, conectando agora... ⏳`
        ];

        const randomEscalation = escalationMessages[Math.floor(Math.random() * escalationMessages.length)];
        swop.recordError(phoneNumber, `ESCALAÇÃO: ${escalation.reason}`, 'ESCALATION_TO_HUMAN');
        return randomEscalation;
    }

    // ===== PREPARAR MENSAGEM COM CONTEXTOS =====
    const fullUserMessage = [
        memoryContext,
        ragContext,
        audioContext || '',
        `Cliente: ${userMessage}`
    ].filter(ctx => ctx).join('\n\n');

    // Adiciona a mensagem do usuário ao histórico
    chatHistories[phoneNumber].push({ 
        role: "user", 
        content: fullUserMessage
    });
    
    console.log(`💬 Processando mensagem com RAG + Memória + Audio...`);

    try {
        const requestStartTime = Date.now();

        // Validar API key
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY não está configurada no .env');
        }

        console.log(`🔄 Chamando OpenAI API com Function Calling habilitado...`);

        // ===== CHAMADA COM FUNCTION CALLING (com self-healing) =====
        const aiTemperature = abOverrides.temperature || 0.95;
        const aiMaxTokens = abOverrides.maxTokens || 300;
        const response = await selfHealing.execute(
            () => openai.chat.completions.create({
                model: "gpt-4o",
                messages: chatHistories[phoneNumber],
                temperature: aiTemperature,
                max_tokens: aiMaxTokens,
                tools: functionCalling.getToolSchemas(),
                tool_choice: 'auto'
            }),
            (ctx) => {
                const adj = ctx.adjustments || {};
                return openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: chatHistories[phoneNumber],
                    temperature: adj.temperature || aiTemperature,
                    max_tokens: adj.max_tokens || aiMaxTokens,
                    tools: functionCalling.getToolSchemas(),
                    tool_choice: 'auto'
                });
            },
            { phoneNumber, operation: 'openai_chat' }
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
            chatHistories[phoneNumber].push({
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
                chatHistories[phoneNumber].push({
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
                messages: chatHistories[phoneNumber],
                temperature: aiTemperature,
                max_tokens: aiMaxTokens
            });

            if (!finalResponse.choices[0]?.message?.content) {
                throw new Error('Resposta final inválida');
            }

            sofiaMessage = finalResponse.choices[0].message.content;
            
            // Adicionar ao histórico
            chatHistories[phoneNumber].push({
                role: "assistant",
                content: sofiaMessage
            });

        } else {
            // Resposta normal sem function calls
            sofiaMessage = choice.message.content;
            chatHistories[phoneNumber].push({ role: "assistant", content: sofiaMessage });
        }

        // Podar histórico para evitar crescimento infinito
        trimChatHistory(phoneNumber);

        // ===== ATUALIZAR MEMÓRIA DO CLIENTE =====
        console.log(`📝 Atualizando memória do cliente...`);
        
        // Registrar tópicos discutidos
        if (userMessage.toLowerCase().includes('prec') || userMessage.toLowerCase().includes('cust')) {
            clientMemory.recordTopicDiscussed(phoneNumber, 'preços_custos');
        }
        if (userMessage.toLowerCase().includes('calvic') || userMessage.toLowerCase().includes('alopec')) {
            clientMemory.recordTopicDiscussed(phoneNumber, 'saúde_capilar');
        }
        
        // Registrar perguntas
        if (userMessage.includes('?')) {
            clientMemory.recordQuestion(phoneNumber, userMessage);
        }

        // Atualizar sentimento baseado na intenção
        const sentimentMap = {
            normal: 'neutral',
            focused: 'neutral',
            high: 'positive',
            escalation: 'negative'
        };
        if (sentimentMap[intent.priority]) {
            clientMemory.updateSentiment(phoneNumber, sentimentMap[intent.priority]);
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

        swop.recordError(phoneNumber, errorMsg, errorType);

        // Verificar se é erro de histórico muito longo e tentar corrigir
        const healing = await selfHealing.analyze(error, null, { phoneNumber });
        if (healing.recovered && healing.result?.action === 'trim_history' && chatHistories[phoneNumber]) {
            const systemMsg = chatHistories[phoneNumber][0];
            const keep = healing.result.keepMessages || 10;
            chatHistories[phoneNumber] = [systemMsg, ...chatHistories[phoneNumber].slice(-keep)];
            console.log(`🔧 Histórico podado automaticamente para ${phoneNumber}`);
            return "Desculpa, precisei reorganizar minha memória aqui. Pode repetir, por favor?";
        }

        return "Desculpa! Tive um problema com minha conexão aqui. Pode tentar novamente em um momento?";
    }
}

module.exports = { getSofiaResponse, analyzeCustomerIntent, shouldEscalateToHuman };
