# Sofia Lead Engine — Arquitetura do Sistema Inteligente de Mensagens

## Visão Geral

Sistema de conversação multi-lead que gerencia centenas de conversas simultâneas no WhatsApp,
com geração de mensagens personalizadas (texto, imagem, áudio, documento) decididas
dinamicamente pela IA com base no perfil, momento do funil e contexto emocional de cada lead.

---

## 1. ARQUITETURA GERAL

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CAMADA DE ENTRADA                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  WhatsApp     │  │  Instagram   │  │  Futuro: Telegram, SMS  │  │
│  │  Business API │  │  DM API      │  │  Email, Web Chat        │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         └─────────────────┼───────────────────────┘                │
│                           ▼                                        │
│                  ┌─────────────────┐                               │
│                  │  Webhook Router  │  (Express/Fastify)            │
│                  │  + Rate Limiter  │                               │
│                  └────────┬────────┘                               │
└───────────────────────────┼─────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     CAMADA DE PROCESSAMENTO                        │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    MESSAGE QUEUE (Bull/Redis)                │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │   │
│  │  │ Lead #1  │ │ Lead #2  │ │ Lead #3  │ │ Lead #N  │       │   │
│  │  │ Queue    │ │ Queue    │ │ Queue    │ │ Queue    │       │   │
│  │  └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬────┘       │   │
│  └────────┼────────────┼────────────┼────────────┼─────────────┘   │
│           ▼            ▼            ▼            ▼                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    WORKER POOL (N workers)                   │  │
│  │                                                              │  │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │  │
│  │  │ Lead Context │→ │ AI Decision   │→ │ Media Generator  │  │  │
│  │  │ Loader       │  │ Engine        │  │ + Sender         │  │  │
│  │  └──────────────┘  └───────────────┘  └──────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CAMADA DE DADOS                               │
│  ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │PostgreSQL│  │  Redis   │  │    S3    │  │ Vector DB        │   │
│  │(Perfis,  │  │(Cache,   │  │(Mídia,  │  │(Pinecone/Qdrant) │   │
│  │ Estados, │  │ Sessões, │  │ Assets, │  │(Embeddings KB)   │   │
│  │ Histórico│  │ Filas)   │  │ Áudios) │  │                  │   │
│  └──────────┘  └─────────┘  └──────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. MÓDULOS DO SISTEMA

### 2.1 — `webhookRouter` (Entrada)

Recebe mensagens de qualquer canal e normaliza para formato interno.

```
Responsabilidades:
├── Receber webhooks do WhatsApp Business API
├── Validar assinatura HMAC dos webhooks
├── Rate limiting por IP e por lead (ex: max 30 msg/min)
├── Normalizar payload para formato interno (MessageEnvelope)
├── Enfileirar na fila do lead correspondente
└── Responder 200 OK imediatamente (processamento assíncrono)
```

**MessageEnvelope** (formato interno):
```js
{
  id: 'msg_uuid',
  leadId: '5511999999999',
  channel: 'whatsapp',         // whatsapp | instagram | telegram
  timestamp: 1741795200000,
  content: {
    type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'location',
    text: 'mensagem do lead',
    mediaUrl: null,             // URL do arquivo se houver mídia
    mimeType: null,
    caption: null
  },
  metadata: {
    profileName: 'João Silva',
    pushName: 'João',
    isForwarded: false
  }
}
```

---

### 2.2 — `leadStateManager` (Gerenciamento de Estado)

Mantém o estado completo de cada lead em Redis (hot) + PostgreSQL (cold).

```
Responsabilidades:
├── Gerenciar estado da conversa por lead
├── Cache em Redis para acesso < 1ms
├── Persistência em PostgreSQL para durabilidade
├── TTL automático para conversas dormentes (24h → archive)
├── Lock distribuído por lead (evita processamento paralelo do mesmo lead)
└── Sincronização Redis ↔ PostgreSQL a cada N operações
```

**LeadState** (schema):
```js
{
  leadId: '5511999999999',
  channel: 'whatsapp',
  status: 'active' | 'paused' | 'dormant' | 'archived',
  mode: 'auto' | 'manual',

  // Perfil do lead
  profile: {
    name: 'João Silva',
    location: 'São Paulo, SP',
    ageGroup: '30-40',
    source: 'instagram_ad',         // De onde veio o lead
    tags: ['interessado', 'preço_ok', 'norwood_3']
  },

  // Dados de domínio (Quality Hair)
  domain: {
    baldnessDegree: 'Norwood III',
    concerns: ['entradas', 'autoestima'],
    allergies: [],
    medicalHistory: []
  },

  // Estado do funil
  funnel: {
    stage: 'awareness' | 'interest' | 'consideration' | 'intent' | 'evaluation' | 'purchase',
    score: 72,                      // 0-100 lead score
    qualifiedAt: null,
    convertedAt: null
  },

  // Contexto emocional
  emotion: {
    currentSentiment: 'curious',    // curious | skeptical | excited | frustrated | neutral
    engagementLevel: 'high',        // low | medium | high
    urgency: 'medium',
    frustrationCount: 0,
    lastPositiveSignal: '2026-03-12T10:30:00Z'
  },

  // Preferências de comunicação (aprendidas pela IA)
  preferences: {
    preferredTone: 'casual',        // formal | casual | technical
    preferredMediaType: 'audio',    // text | audio | image | mixed
    responseSpeed: 'fast',          // fast | normal | slow (baseado no comportamento)
    bestHours: [10, 11, 14, 15],    // Horários com mais engajamento
    messageLength: 'short'          // short | medium | long
  },

  // Controle de mensagens
  messaging: {
    totalMessages: 14,
    lastMessageAt: '2026-03-12T10:30:00Z',
    lastResponseAt: '2026-03-12T10:30:45Z',
    avgResponseTime: 23000,         // ms
    lastMediaSent: 'text',
    consecutiveTextCount: 3,        // Quantas msgs de texto seguidas (para variar)
    topicsDiscussed: ['preços', 'técnica_fue', 'pós_operatório'],
    questionsAsked: ['quanto custa?', 'dói?'],
    objectionsRaised: ['preço alto'],
    unansweredQuestions: []
  },

  // Agendamentos
  appointments: {
    scheduled: [],
    completed: [],
    noShows: []
  },

  // Histórico resumido (para contexto sem explodir tokens)
  conversationSummary: 'João é de SP, Norwood III, interessado em FUE. Preocupado com preço mas entendeu o parcelamento. Quer agendar mas precisa confirmar data com esposa.',

  // Timestamps
  firstContactAt: '2026-03-10T09:15:00Z',
  lastUpdatedAt: '2026-03-12T10:30:45Z'
}
```

---

### 2.3 — `conversationOrchestrator` (Orquestrador Central)

Coordena o fluxo de processamento de cada mensagem.

```
Responsabilidades:
├── Consumir mensagens da fila (Bull worker)
├── Adquirir lock distribuído por lead
├── Carregar LeadState do Redis
├── Pré-processar mídia recebida (transcrição, OCR, etc.)
├── Montar contexto completo para a IA
├── Chamar AI Decision Engine
├── Executar ações (function calling)
├── Gerar mídia de resposta se necessário
├── Enviar resposta pelo canal correto
├── Atualizar LeadState
├── Liberar lock
└── Logging estruturado + métricas
```

**Fluxo de processamento**:
```
mensagem chega
    │
    ▼
┌─ LOCK do lead (Redis SETNX) ──────────────────────────────┐
│                                                             │
│  1. Carregar LeadState (Redis → fallback PostgreSQL)        │
│  2. Pré-processar input:                                    │
│     ├── texto → direto                                      │
│     ├── áudio → Whisper transcription + emotion detection    │
│     ├── imagem → GPT-4o Vision analysis                     │
│     └── documento → text extraction                         │
│  3. Atualizar emotion/engagement no LeadState                │
│  4. Montar prompt:                                           │
│     ├── System prompt (persona Sofia)                        │
│     ├── LeadState context (perfil + funil + emoção)          │
│     ├── Conversation summary (resumo, não histórico bruto)   │
│     ├── RAG context (knowledge base relevante)               │
│     ├── Media decision context (quando variar tipo)          │
│     └── User message                                         │
│  5. Chamar AI Decision Engine → receber:                     │
│     ├── responseText (texto da resposta)                     │
│     ├── mediaDecision (tipo de mídia a enviar)               │
│     ├── toolCalls (funções a executar)                       │
│     ├── stateUpdates (mudanças no LeadState)                 │
│     └── followUpPlan (próximos passos planejados)            │
│  6. Executar toolCalls se houver                             │
│  7. Gerar mídia se mediaDecision != 'text'                   │
│  8. Calcular delay humanizado                                │
│  9. Enviar resposta                                          │
│  10. Atualizar LeadState no Redis + PostgreSQL               │
│  11. Agendar follow-up se necessário                         │
│                                                              │
└─ UNLOCK do lead ─────────────────────────────────────────────┘
```

---

### 2.4 — `aiDecisionEngine` (Motor de Decisão da IA)

O cérebro do sistema. Decide **o que** responder e **como** responder (tipo de mídia).

```
Responsabilidades:
├── Analisar intenção e emoção do lead
├── Decidir tipo de mídia da resposta
├── Gerar texto da resposta
├── Decidir se deve chamar funções (agendamento, CRM, etc.)
├── Sugerir atualizações de estado (funil, sentimento)
├── Planejar follow-ups futuros
└── Detectar necessidade de escalação humana
```

**Decisão de tipo de mídia — Regras do Motor**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                    MEDIA DECISION MATRIX                              │
├──────────────────────┬────────────────┬────────────────────────────────┤
│ CONTEXTO             │ MÉDIA DECIDIDA │ RAZÃO                          │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead perguntou       │ 📝 TEXTO       │ Resposta informativa direta    │
│ sobre preço          │                │                                │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead em dúvida       │ 🖼️ IMAGEM      │ Antes/depois de paciente       │
│ sobre resultados     │                │ mostra prova visual            │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead inseguro,       │ 🎙️ ÁUDIO       │ Tom de voz transmite empatia   │
│ precisa acolhimento  │                │ e proximidade humana           │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead pediu detalhes  │ 📄 DOCUMENTO   │ PDF com informações completas  │
│ técnicos extensos    │                │ sobre o procedimento           │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead enviou áudio    │ 🎙️ ÁUDIO       │ Espelhar formato do lead       │
│                      │                │ (reciprocidade)                │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ 3+ textos seguidos   │ 🖼️ ou 🎙️       │ Quebrar monotonia, variar      │
│ enviados             │                │ formato para manter atenção    │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead no estágio      │ 📄 DOCUMENTO   │ Enviar proposta formal /       │
│ 'evaluation'         │                │ comparativo de preços          │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Lead reagiu com      │ 🖼️ IMAGEM      │ Reforçar com depoimento        │
│ objeção "caro"       │                │ visual de outro paciente       │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Follow-up após       │ 🎙️ ÁUDIO       │ Mensagem pessoal mostra        │
│ 24h sem resposta     │                │ cuidado e não parece bot       │
├──────────────────────┼────────────────┼────────────────────────────────┤
│ Confirmação de       │ 📝 TEXTO       │ Informação clara e objetiva    │
│ agendamento          │ + 🖼️ IMAGEM    │ com mapa/endereço da clínica   │
└──────────────────────┴────────────────┴────────────────────────────────┘
```

**Implementação — Prompt de decisão de mídia**:

A IA recebe um bloco adicional no system prompt:

```
# DECISÃO DE TIPO DE RESPOSTA

Além do texto, você DEVE decidir qual formato de mídia é mais eficaz.
Retorne no campo "media_decision" um dos valores:

- "text_only": Apenas texto (padrão para maioria das respostas)
- "text_with_image": Texto + imagem relevante (antes/depois, mapa, infográfico)
- "audio": Resposta em áudio (para momentos emocionais, follow-ups, acolhimento)
- "document": Enviar PDF/documento (detalhes técnicos, proposta, comparativo)
- "text_with_image_and_audio": Combo (usado raramente, alto impacto)

Considere:
1. quantos textos seguidos já foram enviados (consecutiveTextCount)
2. o formato que o lead usou (se mandou áudio, prefira responder em áudio)
3. o estágio do funil (evaluation → documento, awareness → imagem)
4. o nível emocional (frustrado/inseguro → áudio para humanizar)
5. NUNCA envie o mesmo formato mais de 4x seguidas
```

**Structured Output (resposta da IA)**:
```js
{
  responseText: "Entendo sua preocupação com o preço, João...",
  mediaDecision: "text_with_image",
  mediaParams: {
    imageType: "before_after",       // Tipo do asset a buscar
    imageCaption: "Resultado do paciente após 8 meses — caso similar ao seu"
  },
  toolCalls: [],
  stateUpdates: {
    "emotion.currentSentiment": "considering",
    "funnel.score": 78
  },
  followUp: {
    enabled: true,
    delayHours: 24,
    message: "Oi João, tudo bem? Ficou com alguma dúvida sobre o que conversamos?",
    mediaType: "audio"
  }
}
```

---

### 2.5 — `mediaEngine` (Geração e Gerenciamento de Mídia)

Gera, armazena e serve arquivos de mídia para as respostas.

```
Responsabilidades:
├── Gerar áudios via TTS (Text-to-Speech)
│   ├── OpenAI TTS (tts-1-hd, voz "nova" ou "shimmer")
│   └── Fallback: ElevenLabs para voz customizada
├── Selecionar imagens do asset library
│   ├── Antes/depois categorizados por Norwood
│   ├── Infográficos (preços, timeline, técnicas)
│   ├── Mapas e localização da clínica
│   └── Depoimentos visuais
├── Gerar documentos PDF dinâmicos
│   ├── Proposta personalizada com nome do lead
│   ├── Comparativo de técnicas
│   └── Guia pós-operatório
├── Armazenar mídia gerada em S3/storage local
├── Cachear assets frequentes (Redis)
└── Limpeza automática de mídia temporária (TTL 7 dias)
```

**Submodulos**:

```js
// ttsGenerator.js — Gera áudios para respostas
module.exports = {
  generateAudio(text, options = {}) {
    // voice: 'nova' (feminina, calorosa) — combina com persona Sofia
    // model: 'tts-1-hd' para qualidade
    // format: 'opus' (compacto para WhatsApp)
    // speed: 0.95 (ligeiramente mais lento = mais natural)
  }
}

// imageSelector.js — Seleciona imagem do acervo
module.exports = {
  selectImage(type, leadContext) {
    // type: 'before_after' | 'infographic' | 'testimonial' | 'clinic_map'
    // leadContext: usado para selecionar caso similar (norwood, idade)
    // Retorna: { url, caption, mimeType }
  }
}

// documentGenerator.js — Gera PDFs dinâmicos
module.exports = {
  generateProposal(leadProfile) {
    // Gera PDF com nome do lead, preços, condições
    // Usa template + dados dinâmicos (pdfkit ou puppeteer)
  },
  generateGuide(type) {
    // 'pre_surgery' | 'post_surgery' | 'techniques_comparison'
  }
}
```

---

### 2.6 — `followUpScheduler` (Agendador de Follow-ups)

Gerencia mensagens proativas enviadas pela IA quando o lead não responde.

```
Responsabilidades:
├── Agendar follow-ups com delay configurável
├── Cancelar follow-up se lead responder antes
├── Escalar sequência de follow-ups (1h → 24h → 72h → 7d)
├── Variar tipo de mídia em cada follow-up
├── Respeitar horário comercial (8h-20h)
├── Limite máximo de follow-ups por lead (ex: 5)
└── Registrar resultados (lead respondeu? ignorou? bloqueou?)
```

**Sequência padrão de follow-up**:
```
Follow-up #1 (1h depois):   📝 Texto curto e casual
Follow-up #2 (24h depois):  🎙️ Áudio personalizado com nome do lead
Follow-up #3 (72h depois):  🖼️ Imagem de resultado + texto motivacional
Follow-up #4 (7 dias):      📄 Documento com proposta + texto "último contato"
Follow-up #5 (14 dias):     📝 Texto final de despedida aberta
```

---

### 2.7 — `analyticsCollector` (Métricas e Analytics)

Substitui o `swop.js` com sistema de observabilidade completo.

```
Responsabilidades:
├── Métricas de performance (latência, throughput, error rate)
├── Métricas de negócio (conversão, funil, engagement)
├── Dashboard em tempo real (Grafana)
├── Alertas automáticos (latência > 5s, error rate > 5%)
├── Relatório diário por lead/funil
├── A/B testing de mensagens (qual estilo converte mais)
└── Export para BI (BigQuery, Metabase)
```

**Métricas de negócio**:
```
- leads_total                    (counter)
- leads_by_funnel_stage          (gauge por stage)
- leads_converted                (counter)
- avg_messages_to_conversion     (histogram)
- media_type_engagement_rate     (por tipo: texto vs áudio vs imagem)
- follow_up_response_rate        (% de leads que respondem follow-ups)
- escalation_rate                (% de conversas que precisam de humano)
- avg_conversation_duration      (tempo desde primeiro contato até conversão)
- abandonment_rate_by_stage      (em qual estágio leads param de responder)
```

---

## 3. GERENCIAMENTO DE ESTADO EM PARALELO

### 3.1 — Isolamento por Lead

Cada lead tem sua própria fila no Bull/Redis, garantindo:

```
Lead A ──→ [Fila A] ──→ Worker 1 (processando)
Lead B ──→ [Fila B] ──→ Worker 2 (processando)
Lead C ──→ [Fila C] ──→ Worker 3 (processando)
Lead A ──→ [Fila A] ──→ (aguardando Worker 1 terminar)  ← FIFO por lead
```

- **Por lead**: processamento FIFO (mensagens na ordem)
- **Entre leads**: totalmente paralelo (leads diferentes em workers diferentes)
- **Lock distribuído**: Redis `SETNX lead:lock:{leadId}` com TTL de 60s

### 3.2 — Ciclo de vida do estado

```
                    ┌──────────────┐
                    │   NEW LEAD   │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐     mensagem recebida
              ┌────│   ACTIVE     │◄────────────────────────┐
              │    └──────┬───────┘                         │
              │           │                                 │
              │    sem resposta 1h                          │
              │           ▼                                 │
              │    ┌──────────────┐     lead responde       │
              │    │  FOLLOW_UP   │─────────────────────────┘
              │    └──────┬───────┘
              │           │
              │    sem resposta 7d
              │           ▼
              │    ┌──────────────┐     lead retorna
              │    │   DORMANT    │─────────────────────────┐
              │    └──────┬───────┘                         │
              │           │                                 ▼
              │    sem resposta 30d                  ┌──────────────┐
              │           ▼                         │   ACTIVE     │
              │    ┌──────────────┐                  └──────────────┘
              │    │  ARCHIVED    │
              │    └──────────────┘
              │
              │    /humanmode
              │           ▼
              │    ┌──────────────┐     /automode
              └───►│   MANUAL     │─────────────────────────┐
                   └──────────────┘                         │
                                                            ▼
                                                    ┌──────────────┐
                                                    │   ACTIVE     │
                                                    └──────────────┘
```

### 3.3 — Estratégia de cache (Redis)

```
Chave Redis                          │ TTL    │ Conteúdo
─────────────────────────────────────┼────────┼──────────────────────
lead:state:{leadId}                  │ 24h    │ LeadState completo (JSON)
lead:lock:{leadId}                   │ 60s    │ Lock de processamento
lead:history:{leadId}                │ 2h     │ Últimas 20 mensagens
lead:summary:{leadId}                │ 6h     │ Resumo da conversa (para prompt)
media:cache:{assetId}                │ 7d     │ URL de mídia gerada
followup:scheduled:{leadId}          │ 14d    │ Próximo follow-up agendado
rate:limit:{leadId}                  │ 1min   │ Contador de mensagens
```

---

## 4. COMO A IA DECIDE O TIPO DE MENSAGEM

### 4.1 — Processo de decisão (por mensagem recebida)

```
                    ┌──────────────────┐
                    │ Mensagem recebida│
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐
                    │ Carregar contexto│  ← LeadState + summary + emotion
                    └────────┬─────────┘
                             ▼
              ┌──────────────────────────────┐
              │   REGRAS HARD (obrigatórias) │
              ├──────────────────────────────┤
              │ • Lead mandou áudio?         │──→ Responder em ÁUDIO
              │ • Lead pediu documento?      │──→ Enviar DOCUMENTO
              │ • Confirmação agendamento?   │──→ TEXTO + IMAGEM (mapa)
              │ • Lead frustrado/escalação?  │──→ ÁUDIO (humanizar)
              └──────────┬───────────────────┘
                         │ nenhuma regra hard
                         ▼
              ┌──────────────────────────────┐
              │   REGRAS SOFT (preferência)  │
              ├──────────────────────────────┤
              │ • consecutiveTextCount > 3?  │──→ Preferir IMAGEM ou ÁUDIO
              │ • Horário noturno (>20h)?    │──→ Preferir TEXTO (silencioso)
              │ • Lead prefere áudio?        │──→ Usar ÁUDIO 40% das vezes
              │ • Estágio evaluation?        │──→ Preferir DOCUMENTO
              │ • Score > 80?               │──→ ÁUDIO (criar conexão pessoal)
              └──────────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │   IA GPT-4o DECIDE           │
              │   (com contexto acima +      │
              │    structured output)        │
              └──────────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │   GERAR MÍDIA SE NECESSÁRIO  │
              ├──────────────────────────────┤
              │ • text_only → enviar direto  │
              │ • audio → TTS → upload → send│
              │ • image → selecionar asset   │
              │ • document → gerar PDF       │
              └──────────────────────────────┘
```

### 4.2 — Structured Output da IA

A chamada ao GPT-4o usa **JSON mode** com schema forçado:

```js
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "sofia_response",
      schema: {
        type: "object",
        properties: {
          responseText: {
            type: "string",
            description: "Texto da resposta de Sofia para o lead"
          },
          mediaDecision: {
            type: "string",
            enum: ["text_only", "text_with_image", "audio_only", "audio_with_text",
                   "document", "text_with_document"],
            description: "Tipo de mídia a ser enviada"
          },
          mediaParams: {
            type: "object",
            properties: {
              imageCategory: { type: "string" },
              documentType: { type: "string" },
              audioEmotion: { type: "string", enum: ["warm", "professional", "excited", "empathetic"] }
            }
          },
          stateUpdates: {
            type: "object",
            description: "Campos do LeadState para atualizar"
          },
          followUp: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              delayHours: { type: "number" },
              suggestedMediaType: { type: "string" }
            }
          },
          escalateToHuman: { type: "boolean" },
          escalationReason: { type: "string" }
        },
        required: ["responseText", "mediaDecision"]
      }
    }
  },
  messages: [systemPrompt, ...contextMessages, userMessage],
  tools: functionSchemas,
  tool_choice: "auto"
});
```

### 4.3 — Contexto para decisão de mídia (injetado no prompt)

```
[CONTEXTO DE MÍDIA]
- Últimas 3 mídias enviadas: texto, texto, texto
- Formato preferido do lead: áudio (baseado em 60% das msgs dele serem áudio)
- consecutiveTextCount: 3 (CONSIDERE VARIAR O FORMATO)
- Estágio do funil: consideration
- Sentimento atual: curious
- Horário: 14:30 (horário comercial — qualquer formato OK)
- Assets disponíveis para este caso: antes_depois_norwood3.jpg, guia_fue.pdf
[FIM CONTEXTO DE MÍDIA]
```

---

## 5. TABELA DE MÓDULOS — RESUMO

```
┌─────────────────────────┬──────────────────────────────────────────────────┐
│ MÓDULO                  │ FUNÇÃO                                          │
├─────────────────────────┼──────────────────────────────────────────────────┤
│ webhookRouter           │ Receber msgs, validar, normalizar, enfileirar   │
│ leadStateManager        │ Estado do lead (Redis + PostgreSQL)             │
│ conversationOrchestrator│ Coordenar fluxo completo por mensagem          │
│ aiDecisionEngine        │ Decidir conteúdo + tipo de mídia da resposta   │
│ mediaEngine             │ Gerar áudios (TTS), selecionar imagens,        │
│                         │ criar PDFs dinâmicos                           │
│ followUpScheduler       │ Agendar e gerenciar follow-ups automáticos     │
│ knowledgeBase           │ RAG com embeddings (Vector DB)                 │
│ functionCalling         │ Ações reais (CRM, Calendar, pricing)           │
│ analyticsCollector      │ Métricas, dashboards, alertas                  │
│ channelAdapter          │ Abstração de canal (WhatsApp, Instagram, etc.) │
│ adminPanel              │ Interface web para gerentes (visão de leads)   │
│ humanHandoff            │ Transição suave IA ↔ humano                    │
└─────────────────────────┴──────────────────────────────────────────────────┘
```

---

## 6. STACK TECNOLÓGICO RECOMENDADO

```
Runtime:         Node.js 20+ (ou Bun para performance)
Framework:       Fastify (webhooks) + Bull (filas)
Banco de dados:  PostgreSQL 16 (dados persistentes)
Cache:           Redis 7 (estado, filas, locks, sessões)
Vector DB:       Qdrant ou Pinecone (embeddings RAG)
Storage:         S3 / MinIO (mídia gerada)
IA:              OpenAI GPT-4o (decisão + texto)
TTS:             OpenAI TTS API (tts-1-hd, voz "nova")
STT:             OpenAI Whisper-1 (transcrição de áudio)
Vision:          GPT-4o Vision (análise de imagens recebidas)
PDF:             PDFKit ou Puppeteer (documentos dinâmicos)
WhatsApp:        Business API oficial (webhooks, não web.js)
Monitoramento:   Prometheus + Grafana
Logging:         Pino (structured JSON) → ELK Stack
Deploy:          Docker + Docker Compose (dev) / K8s (prod)
CI/CD:           GitHub Actions
```

---

## 7. MIGRAÇÃO GRADUAL DA ARQUITETURA ATUAL

A migração do Sofia Agent atual para esta arquitetura pode ser feita em fases:

```
FASE 1 (Semana 1-2): Infraestrutura base
  ├── Subir Redis + PostgreSQL (Docker Compose)
  ├── Migrar LeadState de JSON para Redis/PostgreSQL
  ├── Migrar filas in-memory para Bull/Redis
  └── Manter whatsapp-web.js por enquanto

FASE 2 (Semana 3-4): AI Decision Engine
  ├── Implementar structured output (JSON mode)
  ├── Adicionar decisão de mídia ao prompt
  ├── Implementar TTS com OpenAI (áudio de saída)
  ├── Criar asset library de imagens
  └── Manter RAG existente, migrar para Vector DB depois

FASE 3 (Semana 5-6): Follow-up + Media Engine
  ├── Implementar followUpScheduler com Bull delayed jobs
  ├── Criar documentGenerator (PDFs personalizados)
  ├── Implementar imageSelector com acervo categorizado
  └── A/B testing de formatos de mídia

FASE 4 (Semana 7-8): Escala + Observabilidade
  ├── Migrar para WhatsApp Business API oficial
  ├── Implementar analyticsCollector com Prometheus
  ├── Dashboard Grafana com métricas de negócio
  ├── Migrar RAG para Qdrant/Pinecone
  └── Dockerizar tudo para deploy

FASE 5 (Semana 9-10): Multi-canal + Admin
  ├── channelAdapter para Instagram DM
  ├── Admin panel web (leads, funil, métricas)
  ├── Multi-tenancy (suportar múltiplas clínicas)
  └── Audit trail completo
```

---

## 8. EXEMPLO DE CONVERSA COM DECISÃO DE MÍDIA

```
LEAD: "Oi, vi o anúncio de vocês no Instagram"
 └─ IA decide: TEXT_ONLY (primeiro contato, saudação)
 └─ Sofia: "Oi! Que bom que nos encontrou 😊 Sou a Sofia, da Quality Hair..."

LEAD: "Quanto custa o transplante?"
 └─ IA decide: TEXT_WITH_IMAGE (preço + infográfico de parcelamento)
 └─ Sofia: "O investimento é R$ 12.648 em 24x ou R$ 10k à vista..."
 └─ [Envia imagem: infografico_precos.png]

LEAD: "Hmm, é caro né..."
 └─ IA decide: AUDIO (objeção de preço → humanizar com voz)
 └─ Sofia (áudio): "Entendo sua preocupação, João. Mas pensa comigo..."
 └─ [Envia áudio de 25s gerado via TTS]

LEAD: "Pode me mandar mais detalhes sobre a técnica FUE?"
 └─ IA decide: TEXT_WITH_DOCUMENT (pedido técnico → PDF completo)
 └─ Sofia: "Claro! Preparei um material completo pra você..."
 └─ [Envia PDF: guia_fue_quality_hair.pdf]

LEAD: [Envia áudio de 40s com dúvidas]
 └─ IA decide: AUDIO (espelhar formato do lead)
 └─ Sofia (áudio): "Ótimas perguntas, João! Sobre a anestesia..."
 └─ [Envia áudio de 35s]

[24h sem resposta]
 └─ Follow-up #1: AUDIO (personalizado)
 └─ Sofia (áudio): "Oi João! Tudo bem? Fiquei pensando na sua situação..."

LEAD: "Quero agendar a consulta!"
 └─ IA decide: TEXT_ONLY (ação direta → texto objetivo)
 └─ [Chama function: check_available_appointments]
 └─ Sofia: "Maravilha! Temos horários dia 15/03 às 10h ou 14h..."

LEAD: "Dia 15 às 14h"
 └─ IA decide: TEXT_WITH_IMAGE (confirmação + mapa da clínica)
 └─ [Chama function: book_appointment]
 └─ Sofia: "Perfeito, agendado! ✅ Aqui está o endereço..."
 └─ [Envia imagem: mapa_clinica_sp.png]
```
