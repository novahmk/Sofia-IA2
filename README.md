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

