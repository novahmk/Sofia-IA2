# Railway Env Checklist

Checklist pronto para configurar o deploy da Sofia IA no Railway.

## Mínimo para produção estável

```env
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxx
OPENAI_ROUTER_MODEL=gpt-4o-mini
WASENDERAPI_BASE_URL=https://www.wasenderapi.com/api
WASENDERAPI_TOKEN=seu-token-wasenderapi
WASENDERAPI_WEBHOOK_SECRET=seu-webhook-secret
DATABASE_URL=postgresql://usuario:senha@host:5432/database
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
GOOGLE_CALENDAR_ID=primary
USE_DOMAIN_DELEGATION=true
IMPERSONATE_EMAIL=adm@esteticaquality.com
```

## Recomendado

```env
REDIS_URL=redis://default:senha@host:6379
WEBHOOK_VERIFY_TOKEN=seu-verify-token
WEBHOOK_API_KEY=opcional
JWT_SECRET=segredo-forte-opcional
```

## O que validar após o deploy

1. Abrir `GET /health`.
2. Confirmar `ai.openaiConfigured: true`.
3. Confirmar `router.mode: "openai"`.
4. Confirmar `integrations.wasenderapi: true`.
5. Confirmar `integrations.database: true`.
6. Confirmar `integrations.calendar.mode: "configured"`.

## Leitura rápida dos problemas mais comuns

- Sem `OPENAI_API_KEY`: a IA principal entra em fallback e o roteador fica heurístico.
- Sem `WASENDERAPI_TOKEN`: o webhook processa, mas não envia a resposta ao WhatsApp.
- Sem `DATABASE_URL`: leads, histórico e deduplicação ficam em fallback local.
- Sem `GOOGLE_SERVICE_ACCOUNT_JSON` ou `GOOGLE_SERVICE_ACCOUNT_FILE`: o agendamento não consegue operar via Google Calendar.
- Sem `WASENDERAPI_WEBHOOK_SECRET`: o webhook fica sem validação de assinatura.

## Observação sobre Google Calendar

Se usar JSON inline no Railway, prefira `GOOGLE_SERVICE_ACCOUNT_JSON` com o conteúdo completo em uma linha.
Se usar delegação de domínio, mantenha também:

```env
USE_DOMAIN_DELEGATION=true
IMPERSONATE_EMAIL=adm@esteticaquality.com
GOOGLE_CALENDAR_ID=primary
```