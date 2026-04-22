# Sofia-IA2

## Produção Railway

Para rodar no Railway, o servidor principal agora usa `whatsappExpressWebhook.js`.

Checklist operacional pronto para colar variáveis no Railway: [RAILWAY_ENV_CHECKLIST.md](RAILWAY_ENV_CHECKLIST.md)

Onde configurar a chave da OpenAI no Railway:

- Abra o projeto no Railway
- Entre no serviço que executa a Sofia IA
- Abra `Variables`
- Adicione `OPENAI_API_KEY`
- Faça redeploy

- Comando de start: `npm start`
- Rota de webhook: `/webhook`
- Rota de verificação: `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
- Health check: `GET /health`
- Dashboard: `GET /dashboard`

## Variáveis de ambiente necessárias

- `OPENAI_API_KEY`
- `OPENAI_ROUTER_MODEL` (opcional; padrão: `gpt-4o-mini` para o roteador contextual)
- `WASENDERAPI_BASE_URL`
- `WASENDERAPI_TOKEN`
- `PHONE_NUMBER_ID`
- `WEBHOOK_VERIFY_TOKEN`
- `WASENDERAPI_WEBHOOK_SECRET` ou `WEBHOOK_SECRET`
- `WEBHOOK_API_KEY` (opcional)
- `DATABASE_URL` (se usar o banco de dados)
- `JWT_SECRET` (não usado atualmente no servidor principal)

## Validação do roteador OpenAI em produção

O roteador contextual de intenções usa a OpenAI para interpretar a conversa inteira do lead antes de decidir o agente e a intenção.

- Sem `OPENAI_API_KEY`, a aplicação não sobe; o boot falha imediatamente.
- Com `OPENAI_API_KEY`, o roteador contextual fica ativo.
- O modelo pode ser ajustado com `OPENAI_ROUTER_MODEL`.

Como validar após subir o deploy:

- Acesse `GET /health`
- Confirme `ai.openaiConfigured: true`
- Confirme `router.mode: "openai"`
- Confirme `integrations.wasenderapi: true`
- Nos logs de runtime, confirme `🧠 OpenAI: SIM` e `🧭 Router: OPENAI`

## Matriz Railway

Arquivo de deploy atual: [railway.toml](railway.toml)

- Build: `npm install --omit=optional`
- Start: `node whatsappExpressWebhook.js`
- Restart policy: `on_failure` com 3 tentativas

Variáveis que faltarem no Railway afetam o sistema assim:

- `OPENAI_API_KEY`: o processo falha no boot com exit code `1`.
- `WASENDERAPI_TOKEN`: o webhook processa a conversa, mas não consegue enviar respostas para o WhatsApp.
- `WASENDERAPI_WEBHOOK_SECRET` ou `WEBHOOK_SECRET`: o webhook fica sem validação de assinatura.
- `DATABASE_URL`: histórico, deduplicação e leads estruturados caem para fallback local/em memória.
- `REDIS_URL`: fila/cache continuam, mas sem backend Redis configurado.
- `GOOGLE_SERVICE_ACCOUNT_FILE` ou `GOOGLE_SERVICE_ACCOUNT_JSON`: agenda Google não inicializa via conta de serviço.
- `GOOGLE_CALENDAR_ID`: usa `primary` por padrão.

Checklist mínimo para produção estável no Railway:

- `OPENAI_API_KEY`
- `WASENDERAPI_TOKEN`
- `WASENDERAPI_WEBHOOK_SECRET`
- `DATABASE_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON` ou `GOOGLE_SERVICE_ACCOUNT_FILE`

Checklist recomendado:

- `OPENAI_ROUTER_MODEL`
- `REDIS_URL`
- `GOOGLE_CALENDAR_ID`

## Google Calendar via Conta de Serviço

Fluxo recomendado neste projeto:

- Crie uma conta de serviço no Google Cloud Console
- Baixe o JSON gerado
- Salve o arquivo como `serviceAccountKey.json` na raiz do projeto ou defina `GOOGLE_SERVICE_ACCOUNT_FILE`
- Compartilhe a agenda do Google com o e-mail da conta de serviço
- Defina `GOOGLE_CALENDAR_ID` com o ID da agenda compartilhada quando não quiser usar `primary`

Variáveis de ambiente aceitas para conta de serviço:

- `GOOGLE_SERVICE_ACCOUNT_FILE` (opcional; padrão: `serviceAccountKey.json` na raiz do projeto)
- `GOOGLE_SERVICE_ACCOUNT_JSON` (opcional; caminho do arquivo JSON ou JSON completo em string)
- `GOOGLE_CALENDAR_ID` (opcional; padrão: `primary`)

As rotas abaixo continuam existindo apenas para compatibilidade e status. Quando a conta de serviço estiver ativa, não é necessário fazer login.

- Login Google: `GET /auth/google/login`
- Callback Google: `GET /auth/google/callback`
- Status: `GET /auth/google/status`

## Google Calendar via OAuth

Se você realmente quiser manter OAuth com Google Calendar neste projeto:

- Frontend local: `http://localhost:5173`
- Backend local: `http://localhost:8080`
- Login Google: `GET /auth/google/login`
- Callback Google: `GET /auth/google/callback`

No Google Cloud Console, configure:

- Origens JavaScript autorizadas: `http://localhost:5173`
- URI de redirecionamento autorizado: `http://localhost:8080/auth/google/callback`

Variáveis de ambiente para OAuth:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (opcional; padrão: `http://localhost:8080/auth/google/callback`)
- `FRONTEND_URL` (opcional; padrão: `http://localhost:5173`)
- `BACKEND_URL` (opcional; padrão: `http://localhost:8080`)
- `GOOGLE_CALENDAR_ID` (opcional em OAuth; se ausente usa `primary`)
- `GOOGLE_OAUTH_TOKEN_FILE` (opcional; padrão: `google-oauth-token.json` na raiz do projeto)

