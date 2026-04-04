# Sofia IA — Consultora Digital de Terapia Capilar

Agente conversacional inteligente para clínica **Quality Hair**, especializada em mesoterapia capilar e transplante. Opera via WhatsApp (UAZAPI) com IA generativa (GPT-4o-mini), dashboard administrativo em tempo real e integração com sistema de agenda Feegow.

## Stack

- **Runtime:** Node.js (sem Express — `http.createServer` nativo)
- **IA:** OpenAI GPT-4o-mini + embeddings text-embedding-3-small (RAG)
- **WhatsApp:** UAZAPI (free tier) como provider de mensagens
- **Auth:** JWT (jsonwebtoken) com roles admin/atendente/visualizador
- **Real-time:** WebSocket (ws) no path `/ws/dashboard`
- **Dashboard:** SPA HTML puro com Chart.js (sem framework frontend)
- **Banco:** PostgreSQL (opcional, fallback para in-memory)
- **Deploy:** Railway (auto-deploy via GitHub push)

## Arquitetura

O sistema roda com **dois servidores Node.js em paralelo**, separando o tráfego de UI do processamento de mensagens:

```
┌─────────────────────────────────────────────────────────────────┐
│  index.js  (PORT / 3000)  — Servidor principal                  │
│                                                                 │
│  WhatsApp ──► UAZAPI ──► POST /webhook ──► processIncomingMessage()
│                                                │                │
│                          ├─ inputSanitizer (anti-injection)     │
│                          ├─ topicBlacklist (escopo)             │
│                          ├─ clientMemory (perfil)               │
│                          ├─ conversationManager (estado)        │
│                          ├─ knowledgeBase (RAG)                 │
│                          ├─ abTesting (variante A/B)            │
│                          ├─ ai.js → GPT-4o-mini                 │
│                          ├─ kpiTracker (métricas)               │
│                          ├─ auditLogger (LGPD)                  │
│                          └─ messagingClient → UAZAPI → WhatsApp │
│                                                                 │
│  GET  /api/dashboard/*  ──► JWT auth ──► dados reais            │
│  WS   /ws/dashboard     ──► eventos real-time                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  dashboard-server.js  (DASHBOARD_PORT / PORT+1 / 3001)          │
│                                                                 │
│  Browser ──► GET /          ──► dashboard.html (SPA, gzip)      │
│             GET /api/*      ──► proxy → index.js:3000/api/*     │
│             WS  /ws/*       ──► proxy → index.js:3000/ws/*      │
│             GET /health     ──► status do dashboard-server      │
└─────────────────────────────────────────────────────────────────┘
```

### Por que dois servidores?

| Problema (monolítico) | Solução (separado) |
|---|---|
| CPU/memória compartilhada entre UI e IA | Processos isolados, sem contenção |
| Latência de webhook aumenta com tráfego de dashboard | Webhook sempre prioritário em porta dedicada |
| Impossível escalar dashboard independentemente | Cada servidor pode ter recursos próprios |
| Sem cache de assets estáticos | `Cache-Control` e gzip no dashboard-server |

## Módulos

| Arquivo | Função |
|---------|--------|
| `index.js` | Servidor HTTP principal: webhook, API REST, WebSocket (porta `PORT`) |
| `dashboard-server.js` | Servidor dedicado ao dashboard: SPA, proxy /api e /ws, gzip (porta `DASHBOARD_PORT`) |
| `ai.js` | Motor GPT-4o-mini com prompt de sistema, function calling |
| `auth.js` | JWT auth: signup, login, verifyToken, authenticate middleware |
| `wsManager.js` | WebSocket server para push de eventos ao dashboard |
| `knowledgeBase.js` | 13 documentos com embeddings para RAG semântico |
| `conversationManager.js` | Estado de conversas (new → active → closed) |
| `clientMemory.js` | Perfil persistente: nome, tipo de queda, procedimento, sentimento |
| `messagingClient.js` | Client UAZAPI para envio de mensagens WhatsApp |
| `dashboardApi.js` | Agrega dados de todos os módulos para dashboard |
| `kpiTracker.js` | Latência, tokens, sentimento, conversão, volume |
| `abTesting.js` | Teste A/B com variantes de prompt (Empática vs Direta) |
| `intentFlow.js` | Tracking de intenções: greeting → info → pricing → booking |
| `inputSanitizer.js` | Proteção contra prompt injection e jailbreak |
| `topicBlacklist.js` | Bloqueia: concorrentes, política, prescrição, dados terceiros |
| `auditLogger.js` | Trilha de auditoria para LGPD compliance |
| `selfHealing.js` | Auto-recuperação: retry, fallback, circuit breaker |
| `swop.js` | Circuit breaker pattern para serviços externos |
| `feegow.js` | Integração com API Feegow (agendamento médico) |
| `database.js` | Abstração PostgreSQL com fallback in-memory |
| `dashboard.html` | SPA: auth, 9 páginas, Chart.js, WebSocket client |

## Rotas API

### Públicas
```
GET  /health                     → {"status":"ok","uptime":N}
GET  /metrics                    → KPIs + A/B + segurança + performance
POST /webhook                    → Webhook UAZAPI (recebe mensagens WhatsApp)
POST /api/messages               → Endpoint genérico de mensagens (text)
POST /api/auth/signup            → Cadastro {name, email, password, role}
POST /api/auth/login             → Login {email, password} → {token, user}
GET  /dashboard                  → Serve dashboard.html
```

### Autenticadas (Header: `Authorization: Bearer <JWT>`)
```
GET  /api/dashboard/overview     → KPIs, funil, volume horário, serviços
GET  /api/dashboard/conversations→ Conversas ativas + histórico recente
GET  /api/dashboard/leads        → Leads com perfil e sentimento
GET  /api/dashboard/appointments → Agendamentos do dia
GET  /api/dashboard/kpis         → Latência, tokens, sentimento detalhado
GET  /api/dashboard/ab-test      → Variantes com taxa de conversão
GET  /api/dashboard/system       → Circuit breakers, self-healing log
GET  /api/dashboard/security     → Auditoria, injeções, LGPD stats
GET  /api/dashboard/knowledge-base→ Documentos, gaps, query count
POST /api/dashboard/knowledge-base→ Adicionar documento {title, category, content}
POST /api/dashboard/conversations/:id/handoff → Transferir para humano
POST /api/dashboard/lgpd/export  → Exportar dados {phone}
POST /api/dashboard/lgpd/delete  → Excluir dados {phone}
```

### WebSocket
```
ws://HOST/ws/dashboard?token=JWT → Eventos: new_message, conversation_updated,
                                    handoff_requested, kpi_update, system_alert
```

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `PORT` | Railway define | Porta do servidor principal (index.js) |
| `DASHBOARD_PORT` | ❌ | Porta do dashboard-server (padrão: PORT+1) |
| `OPENAI_API_KEY` | ✅ | Chave API OpenAI (GPT-4o-mini + embeddings) |
| `UAZAPI_BASE_URL` | ✅ | URL base UAZAPI (`https://free.uazapi.com`) |
| `UAZAPI_TOKEN` | ✅ | Token da instância UAZAPI WhatsApp |
| `JWT_SECRET` | ✅ | Secret para assinar tokens JWT (64 chars hex) |
| `FEEGOW_TOKEN` | ❌ | Token JWT da API Feegow (agenda médica) |
| `DATABASE_URL` | ❌ | PostgreSQL connection string (fallback: in-memory) |
| `ADMIN_PHONES` | ❌ | Telefones admin separados por vírgula |

## Deploy no Railway

1. Conectar repo GitHub `novahmk/Sofia-IA2` no Railway
2. Configurar variáveis de ambiente (acima) em Variables
3. Railway usa o `startCommand` do `railway.toml`: `node index.js & node dashboard-server.js`
4. Health check automático em `/health` (index.js, porta `PORT`)
5. Auto-deploy a cada push na branch `main`

### Portas

| Servidor | Variável | Padrão | Função |
|---|---|---|---|
| `index.js` | `PORT` | Railway define | Webhook, API, WebSocket |
| `dashboard-server.js` | `DASHBOARD_PORT` | `PORT + 1` | Dashboard SPA + proxy |

> **Nota Railway:** O Railway expõe apenas a porta definida em `PORT`. Para acessar o dashboard-server externamente, configure `DASHBOARD_PORT` e exponha essa porta no painel do Railway, ou use o dashboard-server como único ponto de entrada (ele faz proxy para a API).

### Desenvolvimento local

```bash
# Iniciar ambos os servidores
npm run start:all

# Ou separadamente em terminais diferentes
node index.js           # API na porta 3000
node dashboard-server.js  # Dashboard na porta 3001
```

## Notas para IA do Railway

- **NÃO usa Express** — ambos os servidores usam `http.createServer` nativo
- **Dois processos:** `index.js` (API/webhook) e `dashboard-server.js` (UI/proxy) rodam em paralelo
- **Todas as rotas de API estão em `index.js`** dentro do callback do server
- **Padrão de rota:** `if (req.method === 'GET' && req.url === '/path') { ... return; }`
- **Auth:** módulo `auth.js` exporta `authenticate(req, res)` que retorna `{id, email, role}` ou envia 401
- **WebSocket** roda no mesmo server HTTP do `index.js` via `wsManager.init(server)` — o `dashboard-server.js` faz proxy do upgrade
- **Dashboard HTML** é servido pelo `dashboard-server.js` com gzip e cache headers
- **Porta principal:** sempre `process.env.PORT` (Railway injeta automaticamente)
- **Porta dashboard:** `process.env.DASHBOARD_PORT` ou `PORT + 1` (padrão: 3001)
- **Sem build step** — Node.js puro, sem TypeScript, sem bundler
- **Dependências:** `npm install` é executado automaticamente pelo Nixpacks
