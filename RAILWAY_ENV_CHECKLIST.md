# Railway Env Checklist

Checklist pronto para configurar o deploy da Sofia IA no Railway.

## Onde configurar no Railway

No serviço que executa a Sofia IA:

1. Abra o projeto no Railway.
2. Entre no serviço da aplicação.
3. Abra a aba Variables.
4. Crie a variável `OPENAI_API_KEY` com a chave real da OpenAI.
5. Salve e faça redeploy ou aguarde o redeploy automático.

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
MONITORING_ALERT_PHONE=5511993521100
MONITORING_PING_TOKEN=token-forte-monitoramento
MONITOR_INTERVAL_MS=3600000
MONITOR_ALERT_REPEAT_MS=3600000
```

## O que validar após o deploy

1. Abrir `GET /health`.
2. Confirmar `ai.openaiConfigured: true`.
3. Confirmar `router.mode: "openai"`.
4. Confirmar `integrations.wasenderapi: true`.
5. Confirmar `integrations.database: true`.
6. Confirmar `integrations.calendar.mode: "configured"`.
7. Testar `POST /ping` com `Authorization: Bearer <MONITORING_PING_TOKEN>`.
8. Confirmar recebimento de alerta no WhatsApp de monitoramento.

## Leitura rápida dos problemas mais comuns

- Sem `OPENAI_API_KEY`: a aplicação falha no boot imediatamente com exit code 1.
- Sem `WASENDERAPI_TOKEN`: o webhook processa, mas não envia a resposta ao WhatsApp.
- Sem `DATABASE_URL`: leads, histórico e deduplicação ficam em fallback local.
- Sem `GOOGLE_SERVICE_ACCOUNT_JSON` ou `GOOGLE_SERVICE_ACCOUNT_FILE`: o agendamento não consegue operar via Google Calendar.
- Sem `WASENDERAPI_WEBHOOK_SECRET`: o webhook fica sem validação de assinatura.

## Observação sobre Google Calendar

Se usar JSON inline no Railway, prefira `GOOGLE_SERVICE_ACCOUNT_JSON` com o conteúdo completo em uma linha.
O runtime atual resolve as credenciais nesta ordem:

1. `GOOGLE_SERVICE_ACCOUNT_JSON` com JSON inline
2. `GOOGLE_SERVICE_ACCOUNT_JSON` apontando para arquivo
3. `GOOGLE_SERVICE_ACCOUNT_FILE`
4. `serviceAccountKey.json` na raiz
5. OAuth Google

Se `GOOGLE_SERVICE_ACCOUNT_JSON` estiver preenchida corretamente, o deploy não deve mais depender de `/app/serviceAccountKey.json`.

Se usar delegação de domínio, mantenha também:

```env
USE_DOMAIN_DELEGATION=true
IMPERSONATE_EMAIL=adm@esteticaquality.com
GOOGLE_CALENDAR_ID=primary
```