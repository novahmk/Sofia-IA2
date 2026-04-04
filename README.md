# Sofia Agent — Especialista em Mesoterapia Capilar

Agente conversacional inteligente para clínica **Quality Hair**, especializada em mesoterapia capilar e transplante. Opera via WhatsApp (UAZAPI) com IA generativa (GPT-4o-mini + RAG), dashboard administrativo em tempo real e integração com sistema de agenda Feegow.

## Stack

| Camada | Tecnologia |
|--------|-----------|
| **Runtime** | Node.js 22.22.2 — HTTP nativo (`http.createServer`, sem Express) |
| **IA** | OpenAI GPT-4o-mini + embeddings `text-embedding-3-small` (RAG semântico) |
| **Messaging** | UAZAPI (WhatsApp) via `POST /webhook` + endpoint genérico `POST /api/messages` |
| **Auth** | JWT (`jsonwebtoken`) com roles `admin` / `atendente` / `visualizador` |
| **Real-time** | WebSocket (`ws`) no path `/ws/dashboard?token=JWT` |
| **Dashboard** | SPA HTML puro com Chart.js (sem framework frontend) |
| **Banco** | PostgreSQL (`pg`) com fallback automático para in-memory |
| **Agenda** | Feegow API (agendamento médico) |
| **Deploy** | Railway com Railpack — auto-deploy via push no GitHub `main` |

## Arquitetura

```
                        ┌─────────────────────────────────────────┐
                        │           SOFIA IA2 — index.js          │
                        │         http.createServer (Node.js)     │
                        └──────────────────┬──────────────────────┘
                                           │
          ┌────────────────────────────────┼────────────────────────────────┐
          │                               │                                │
          ▼                               ▼                                ▼
  POST /webhook                   GET /api/dashboard/*            WS /ws/dashboard
  POST /api/messages              POST /api/auth/*                ?token=JWT
  (UAZAPI WhatsApp)               (JWT Bearer auth)               (real-time events)
          │                               │                                │
          ▼                               ▼                                ▼
  processIncomingMessage()        dashboardApi.js                 wsManager.js
          │                       auth.js (JWT verify)
          ├─ inputSanitizer       kpiTracker.js
          ├─ topicBlacklist       abTesting.js
          ├─ conversationManager  clientMemory.js
          ├─ clientMemory         selfHealing.js
          ├─ knowledgeBase (RAG)  swop.js
          ├─ abTesting
          ├─ ai.js ──────────────────────────────► OpenAI GPT-4o-mini
          ├─ kpiTracker                                    │
          ├─ auditLogger (LGPD)                            │ RAG context
          └─ messagingClient ◄──────────────── knowledgeBase.js
                  │                            (embeddings OpenAI)
                  ▼
          UAZAPI → WhatsApp                         │
                                                    ▼
                                             database.js
                                          PostgreSQL / in-memory
```

## Módulos

| Arquivo | Função |
|---------|--------|
| `index.js` | Servidor HTTP principal + todas as rotas (webhook, API REST, dashboard) |
| `ai.js` | Motor GPT-4o-mini: prompt de sistema, RAG, function calling, compressão de histórico |
| `auth.js` | JWT auth: `signup`, `login`, `verifyToken`, `authenticate` middleware |
| `wsManager.js` | WebSocket server para push de eventos ao dashboard em tempo real |
| `knowledgeBase.js` | RAG semântico: documentos com embeddings `text-embedding-3-small` |
| `conversationManager.js` | Estado de conversas por telefone: `new → active → closed` |
| `clientMemory.js` | Perfil persistente: nome, tipo de queda, procedimento, funil, sentimento |
| `messagingClient.js` | Client UAZAPI para envio de mensagens e verificação de status |
| `dashboardApi.js` | Agrega dados de todos os módulos para os endpoints do dashboard |
| `kpiTracker.js` | Latência, tokens, sentimento, conversão, volume por hora |
| `abTesting.js` | Teste A/B com variantes de prompt (Empática vs Direta) |
| `intentFlow.js` | Tracking de intenções: `greeting → info → pricing → booking` |
| `inputSanitizer.js` | Proteção contra prompt injection e jailbreak |
| `topicBlacklist.js` | Bloqueia tópicos fora do escopo: concorrentes, política, prescrição |
| `auditLogger.js` | Trilha de auditoria completa para LGPD compliance |
| `selfHealing.js` | Auto-recuperação: retry, fallback, análise de erros recuperáveis |
| `swop.js` | Circuit breaker pattern para serviços externos (OpenAI, UAZAPI, Feegow) |
| `feegow.js` | Integração com API Feegow: listagem de procedimentos e agendamentos |
| `database.js` | Abstração PostgreSQL com fallback in-memory e API síncrona |
| `migrations.js` | Cria todas as tabelas no PostgreSQL (idempotente — `IF NOT EXISTS`) |
| `audioProcessor.js` | Transcrição de áudio via Whisper + detecção de tipo de mídia |
| `functionCalling.js` | Function calling OpenAI: agendamento, consulta de dados, etc. |
| `calendar.js` | Integração com Google Calendar para agendamentos |
| `dashboard.html` | SPA: auth, 9 páginas, Chart.js, WebSocket client |

## Rotas HTTP

### Públicas (sem autenticação)

| Método | Path | Payload | Resposta |
|--------|------|---------|----------|
| `GET` | `/health` | — | `{"status":"ok","uptime":N}` |
| `GET` | `/metrics` | — | KPIs + A/B + segurança + performance |
| `POST` | `/webhook` | Payload UAZAPI WhatsApp | `{"status":"received"}` (async) |
| `POST` | `/api/messages` | Payload genérico de mensagem | `{"status":"received"}` (async) |
| `POST` | `/api/auth/signup` | `{name, email, password, role}` | `{token, user}` ou erro 400 |
| `POST` | `/api/auth/login` | `{email, password}` | `{token, user}` ou erro 401 |
| `POST` | `/api/auth/forgot-password` | `{email}` | `{success: true, message}` |
| `GET` | `/dashboard` | — | `dashboard.html` (SPA) |

> **Nota sobre webhooks:** `POST /webhook` e `POST /api/messages` respondem `200` imediatamente e processam a mensagem de forma assíncrona via `processIncomingMessage()`. Não aguardam a resposta da IA.

### Autenticadas (Header: `Authorization: Bearer <JWT>`)

| Método | Path | Descrição |
|--------|------|-----------|
| `GET` | `/api/dashboard/overview` | KPIs, funil de conversão, volume horário, status dos serviços |
| `GET` | `/api/dashboard/conversations` | Conversas ativas + histórico recente (últimas 10) |
| `GET` | `/api/dashboard/leads` | Leads com perfil, sentimento, estágio do funil |
| `GET` | `/api/dashboard/appointments` | Agendamentos do dia com status |
| `GET` | `/api/dashboard/kpis` | Latência, tokens, sentimento detalhado, distribuição de intenções |
| `GET` | `/api/dashboard/ab-test` | Variantes A/B com taxa de conversão e confiança estatística |
| `GET` | `/api/dashboard/system` | Circuit breakers, self-healing log, latência histórica |
| `GET` | `/api/dashboard/security` | Auditoria, tentativas de injeção, stats LGPD |
| `GET` | `/api/dashboard/knowledge-base` | Documentos, gaps detectados, query count |
| `POST` | `/api/dashboard/knowledge-base` | Adicionar documento `{question, answer}` à base de conhecimento |
| `POST` | `/api/dashboard/conversations/:id/handoff` | Transferir conversa para atendimento humano |
| `POST` | `/api/dashboard/lgpd/export` | Exportar dados do cliente `{phone}` |
| `POST` | `/api/dashboard/lgpd/delete` | Excluir dados do cliente `{phone}` (somente `admin`) |

### Legado (backward compat)

| Método | Path | Descrição |
|--------|------|-----------|
| `GET` | `/dashboard/data` | JSON com dados agregados (sem auth) |
| `GET` | `/dashboard/health-check` | Health check de todos os serviços |

### WebSocket

```
ws://HOST/ws/dashboard?token=<JWT>

Eventos emitidos pelo servidor:
  new_message          → {phone, totalToday}
  conversation_updated → {phone, mode, lastMessage}
  handoff_requested    → {clientName, phone, activeCount}
  kpi_update           → dados de KPI atualizados
  system_alert         → alertas de sistema
```

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `PORT` | Railway injeta | Porta do servidor HTTP (não configurar manualmente) |
| `OPENAI_API_KEY` | ✅ | Chave API OpenAI (GPT-4o-mini + embeddings) |
| `UAZAPI_BASE_URL` | ✅ | URL base UAZAPI (ex: `https://free.uazapi.com`) |
| `UAZAPI_TOKEN` | ✅ | Token da instância UAZAPI WhatsApp |
| `JWT_SECRET` | ✅ | Secret para assinar tokens JWT (recomendado: 64 chars hex) |
| `DATABASE_URL` | ❌ | PostgreSQL connection string — sem ela, usa in-memory |
| `FEEGOW_TOKEN` | ❌ | Token JWT da API Feegow (agenda médica) |
| `ADMIN_PHONES` | ❌ | Telefones admin separados por vírgula (comandos de controle) |

## Deploy no Railway

### Passo a passo

1. Conectar o repositório `novahmk/Sofia-IA2` no Railway
2. Configurar as variáveis de ambiente obrigatórias em **Variables**
3. Adicionar um serviço PostgreSQL e copiar `DATABASE_URL` para as variáveis
4. Railway usa `railway.toml` (Railpack) para build e deploy
5. O pre-deploy command `node migrations.js` cria as tabelas automaticamente
6. Health check automático em `GET /health` após cada deploy
7. Auto-deploy a cada push na branch `main`

### Testar endpoints localmente

```bash
# Health check
curl http://localhost:3000/health

# Login no dashboard
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@qualityhair.com","password":"senha123"}'

# Simular webhook UAZAPI
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"phone":"5511999999999","fromMe":false,"isGroup":false,"message":{"text":"Olá, quero saber sobre mesoterapia"}}'

# Endpoint genérico de mensagens
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -d '{"phone":"5511999999999","body":"Quanto custa o tratamento?"}'

# Dashboard overview (requer JWT)
TOKEN="seu_jwt_aqui"
curl http://localhost:3000/api/dashboard/overview \
  -H "Authorization: Bearer $TOKEN"
```

## Banco de Dados (PostgreSQL)

Tabelas criadas por `migrations.js`:

| Tabela | Descrição |
|--------|-----------|
| `client_memories` | Perfil persistente de cada cliente (JSONB) |
| `conversation_states` | Estado das conversas por telefone (JSONB) |
| `clients_data` | Dados de clientes usados pelo function calling |
| `appointments` | Agendamentos com data, hora, status e tipo |
| `audit_log` | Trilha de auditoria completa (LGPD) |
| `consents` | Consentimentos LGPD por cliente |
| `conversations` | Histórico completo de mensagens individuais |

## Notas para IA do Railway

**Padrões de código:**
- **NÃO usa Express** — servidor é `http.createServer` nativo com callback `async (req, res) => {}`
- **Todas as rotas estão em `index.js`** dentro do callback do server
- **Padrão de rota:** `if (req.method === 'GET' && req.url === '/path') { ... return; }`
- **Auth:** `auth.authenticate(req, res)` retorna `{id, email, role}` ou envia 401 e retorna `null`

**Comportamento assíncrono:**
- `POST /webhook` e `POST /api/messages` respondem `200` imediatamente via `req.on('data')`/`req.on('end')` — **não** usam `await readBody()`
- `processIncomingMessage()` é chamado de forma fire-and-forget (sem `await`)
- Fila de mensagens por usuário: `messageQueues[phone] = Promise chain` (garante ordem FIFO)

**Infraestrutura:**
- **WebSocket** roda no mesmo server HTTP via `wsManager.init(server)` — não em porta separada
- **Dashboard HTML** é servido como arquivo estático: `fs.readFileSync('dashboard.html')`
- **Porta:** sempre `process.env.PORT` (Railway injeta automaticamente) com fallback para `3000`
- **Sem build step** — Node.js puro, sem TypeScript, sem bundler
- **Rate limiting** em memória (in-process) — estado perdido em restart

**Limitações conhecidas:**
- Rate limiting não é compartilhado entre instâncias (não usa Redis)
- `sendTyping()` e `stopTyping()` são no-ops no UAZAPI free tier
- Embeddings da knowledge base são gerados em memória no startup
- `DATABASE_URL` ausente → todos os dados em memória (perdidos em restart)

## Licença

Proprietário — Quality Hair. Todos os direitos reservados.
