# Sofia-IA2

## Produção Railway

Para rodar no Railway, o servidor principal agora usa `whatsappExpressWebhook.js`.

- Comando de start: `npm start`
- Rota de webhook: `/webhook`
- Rota de verificação: `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
- Health check: `GET /health`
- Dashboard: `GET /dashboard`

## Variáveis de ambiente necessárias

- `OPENAI_API_KEY`
- `WASENDERAPI_BASE_URL`
- `WASENDERAPI_TOKEN`
- `PHONE_NUMBER_ID`
- `WEBHOOK_VERIFY_TOKEN`
- `WASENDERAPI_WEBHOOK_SECRET` ou `WEBHOOK_SECRET`
- `WEBHOOK_API_KEY` (opcional)
- `DATABASE_URL` (se usar o banco de dados)
- `JWT_SECRET` (não usado atualmente no servidor principal)

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

