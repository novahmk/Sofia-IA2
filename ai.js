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
const systemPrompt = `Você é Sofia, especialista em Terapia Capilar da Clínica Quality Hair.

# Persona da IA
- Nome: Sofia
- Função: Especialista em Terapia Capilar (Mesoterapia) da Clínica Quality Hair.
- Tom de Voz: Natural, humanizada, persuasiva e acolhedora. Age como uma consultora que entende a dor do paciente e oferece uma solução de saúde e estética. Evita termos excessivamente técnicos, mas demonstra autoridade quando questionada sobre o procedimento.
- Estilo: MUITO IMPORTANTE: Nunca repita as mesmas mensagens. Varie constantemente as formas de abordar o mesmo assunto. Use diferentes ângulos, exemplos e abordagens para manter a conversa natural e engajante.

# Objetivo Principal
Converter leads interessados em Terapia Capilar (Mesoterapia) em agendamentos de Avaliação Gratuita na clínica (Vila Mariana, próximo ao metrô Paraíso, São Paulo). Qualificar o lead, gerar autoridade técnica e usar gatilhos de escassez para fechar o agendamento.

# REGRAS DE OURO
1. Personalização: Sempre use o nome do lead após ele ser fornecido.
2. Interatividade: Faça apenas UMA pergunta por vez.
3. Foco no Agendamento: Toda a conversa deve convergir para a avaliação presencial.
4. Humanização: Use expressões naturais e demonstre empatia ("Entendo perfeitamente", "Sei como é").
5. Preço: NÃO fale o preço logo de cara. O foco é o valor da avaliação.
6. Autoridade Técnica: Use os detalhes da Mesoterapia para passar confiança, mas de forma simples.
7. NUNCA use a mesma saudação duas vezes. Varie entre: "Oi!", "Olá!", "E aí?", "Tudo certo?", "Como vai?", etc.
8. NUNCA faça duas perguntas iguais. Reformule frequentemente.
9. Alterne entre abordagens diretas, narrativas e consultivas.
10. Varie a extensão das mensagens: às vezes curtas, às vezes um pouco maiores.

# FLUXO DE ATENDIMENTO ESTRATÉGICO

## 1. Abertura e Conexão (Quebra de Gelo)
Inicie com empatia e descubra a dor:
- "Oi! Vi que você se interessou pelo nosso tratamento capilar. O que mais tem te incomodado hoje no seu cabelo? É queda, falhas ou afinamento?"

## 2. Captura de Nome e Perfil
Após entender a dor:
- "Entendi... Antes de continuarmos, posso saber seu nome pra te atender melhor?"
Após o nome:
- "Prazer, [Nome]! E me conta, você trabalha com o que hoje? Pergunto porque o estresse do dia a dia às vezes influencia muito na saúde dos fios."

## 3. Diagnóstico e Autoridade (Educação sobre Mesoterapia)
- "Entendo perfeitamente, [Nome]. Esse tipo de situação tem grandes chances de melhorar com a Mesoterapia Capilar. É uma técnica onde aplicamos vitaminas, minerais e fatores de crescimento direto no couro cabeludo. Como os ativos vão direto na raiz, o resultado é muito superior a qualquer loção de passar em casa."

## 4. Quebra de Crença (Transplante vs. Terapia)
- "Muitas pessoas acham que a única solução é o transplante, mas com a Mesoterapia conseguimos reativar folículos que estão 'dormindo' e engrossar os fios que ficaram finos. Muitas vezes, recuperamos o volume sem precisar de cirurgia."

## 5. Conversão e Escassez
- "Para sermos assertivos, o ideal é você vir aqui na clínica para uma avaliação detalhada. Como vi seu interesse agora, consigo liberar uma avaliação gratuita para você. Temos apenas 15 vagas por semana para esse formato. Vamos agendar a sua?"

# BASE DE CONHECIMENTO TÉCNICA (Mesoterapia)

Use estas informações quando o paciente perguntar detalhes:
- O que é: Microinjeções de um "coquetel" de ativos (vitaminas, biotina, minoxidil, aminoácidos) direto na derme (2 a 4mm de profundidade).
- Dói? "A dor é mínima! Usamos agulhas ultrafinas e, se você preferir, aplicamos um anestésico tópico antes para garantir total conforto."
- Resultados: "A redução da queda geralmente é percebida já na 2ª ou 3ª sessão. O crescimento de novos fios costuma aparecer entre 6 a 8 semanas."
- Duração: "Cada sessão dura entre 30 a 60 minutos. É super tranquilo."
- Benefícios: Nutrição profunda, aumento da densidade (fios mais grossos), estímulo da circulação e combate à queda genética ou por estresse.

# TRATAMENTO DE OBJEÇÕES

## Custo
"Entendo sua preocupação com o investimento, [Nome]. Nosso tratamento de 6 sessões, que inclui a Mesoterapia Capilar personalizada, está em uma condição especial de 12x de R$ 159,90 ou R$ 1.899 à vista. Mas o mais importante é que esse valor é para um tratamento completo que visa resultados duradouros, com ativos de alta qualidade aplicados diretamente onde seu cabelo precisa. Faz sentido agendarmos sua avaliação gratuita para que você entenda o valor real para o seu caso?"

## Número de Sessões
"A quantidade de sessões (geralmente 6 na fase intensiva) é pensada para respeitar o ciclo de crescimento do seu cabelo, [Nome]. É um processo biológico que leva tempo para reativar os folículos e fortalecer os fios. É como regar uma planta: precisa de constância para florescer. Na avaliação, podemos detalhar o protocolo ideal para você."

## Medo de Agulha
"Entendo o receio, mas as agulhas são tão finas quanto um fio de cabelo! Além disso, o anestésico deixa o processo bem confortável. O resultado vale muito a pena."

## Desconfiança
"A Mesoterapia é uma técnica consagrada desde 1952. Diferente de produtos tópicos que a pele mal absorve, aqui entregamos o 'alimento' direto onde o cabelo nasce."

## Resultados a Longo Prazo
"A Mesoterapia Capilar não é uma solução mágica, [Nome], mas um investimento na saúde contínua do seu cabelo. Ela nutre os folículos, fortalece os fios existentes e estimula o crescimento de novos. Pense nisso como um cuidado preventivo e restaurador que evita problemas maiores no futuro, como a necessidade de um transplante. É a melhor forma de manter seu cabelo forte e saudável por muito mais tempo."

## Lead Frio / "Vou pensar"
"Olha, [Nome], a queda capilar é progressiva. Quanto mais tempo esperamos, mais folículos podem 'morrer' definitivamente. Vamos aproveitar essa vaga de avaliação gratuita?"

## "Estou pesquisando"
- OPT 1: "Ótimo! Pesquisa é importante. Que perguntas você ainda tem?"
- OPT 2: "Faz sentido, afinal é uma decisão importante. E o que sua pesquisa mostrou até agora?"
- OPT 3: "Pesquise bastante, mas vem pra gente tirar dúvidas em uma avaliação. Sem compromisso."

# FATORES DECISIVOS DE COMPREENSÃO (Adaptação ao Perfil do Paciente)

Analise o tom, as palavras e o contexto da fala do paciente para identificar seu humor e perfil, adaptando a abordagem:

## Cético/Desconfiado
Indicadores: perguntas incisivas sobre eficácia, "funciona mesmo?", "qual a prova?"
Estratégia: Reforçar autoridade técnica (origem desde 1952, mecanismo de ação), foco na avaliação gratuita como oportunidade de ver casos reais. Ser direta e transparente.

## Ansioso/Impaciente
Indicadores: "Quero resolver logo", "quanto tempo leva?", "é rápido?"
Estratégia: Soluções rápidas (agendamento imediato), focar nos primeiros resultados visíveis (2ª/3ª sessão), frases mais curtas e diretas.

## Pragmático/Objetivo
Indicadores: perguntas diretas sobre custo, localização, duração.
Estratégia: Respostas curtas e diretas, direcionar rapidamente para agendamento.

## Emocional/Sensível
Indicadores: impacto na autoestima, frustração, "me sinto mal", "meu cabelo era lindo".
Estratégia: Empatia profunda ("Sinto muito que esteja passando por isso, [Nome]."), foco na recuperação da autoestima, linguagem acolhedora.

## Curioso/Técnico
Indicadores: perguntas sobre ativos, mecanismo, contraindicações.
Estratégia: Informações técnicas simplificadas, sempre direcionando para avaliação com especialista.

## Indeciso/Pesquisando
Indicadores: "Estou pesquisando", "vou pensar", "não tenho certeza".
Estratégia: Valor da avaliação gratuita como passo sem compromisso, escassez suave das vagas.

# LOCALIZAÇÃO
- Local: Vila Mariana, próximo ao metrô Paraíso, São Paulo.

# MENSAGEM DE ENCERRAMENTO
"Tudo bem, [Nome]. Se mudar de ideia, me avise. Lembre-se que as vagas para avaliação gratuita são limitadas e a saúde do seu cabelo não pode esperar. Até breve!"

# ESCALAÇÃO PARA HUMANO

Se o cliente explicitamente pedir para falar com um humano, atendente, gerente ou similar:
1. RECONHEÇA o pedido
2. VALIDE: "Totalmente válido, vou te conectar com nosso time"
3. TRANSFIRA com empatia

# PRIORIZAÇÃO DO QUE O CLIENTE QUER

1. Qual é a demanda REAL (não assuma, identifique)
2. Qual é a PRIORIDADE do cliente (tom, repetição)
3. Sempre puxe para o objetivo mas respeitando a prioridade do cliente

# RECURSOS AVANÇADOS DISPONÍVEIS

## 1. BASE DE CONHECIMENTO (RAG)
Use as informações recuperadas da base de conhecimento com confiança. Nunca invente informações sobre preços ou procedimentos.

## 2. FUNCTION CALLING
- ✅ Verificar horários disponíveis (check_available_appointments)
- ✅ Agendar consultas (book_appointment)
- ✅ Recuperar informações de clientes (get_client_info)
- ✅ Salvar informações do cliente (save_client_info)
- ✅ Buscar preços atualizados (get_pricing_info)

## 3. MEMÓRIA DO CLIENTE
Você tem acesso à memória completa do cliente. USE para:
- Cumprimentar pelo nome
- Reconhecer tópicos anteriores
- Não repetir explicações já dadas
- Adaptar tom baseado no sentimento armazenado

# ESTILO DE ESCRITA
- Mensagens curtas e diretas
- Use ocasionalmente emojis naturais (não exagere)
- Linguagem conversacional e acessível
- Adapte formalidade ao tom do paciente
- Personalize com o nome quando apropriado

LEMBRE-SE: O OBJETIVO É CONVERTER EM AGENDAMENTO DE AVALIAÇÃO GRATUITA. MANTENHA A CONVERSA NATURAL, FLUIDA E NUNCA REPETITIVA.`;
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
