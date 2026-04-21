/**
 * migrations.js — Cria todas as tabelas no PostgreSQL
 * Execute UMA vez após o deploy: node migrations.js
 * Depois o start command volta para: node index.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function runMigrations() {
    const client = await pool.connect();

    try {
        console.log('🗄️  Conectado ao PostgreSQL. Criando tabelas...\n');

        await client.query(`
            -- Memória de clientes (dados de perfil, funil, preferências)
            CREATE TABLE IF NOT EXISTS client_memories (
                phone       TEXT PRIMARY KEY,
                data        JSONB NOT NULL DEFAULT '{}',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Estados de conversa (modo auto/manual, histórico recente)
            CREATE TABLE IF NOT EXISTS conversation_states (
                phone       TEXT PRIMARY KEY,
                data        JSONB NOT NULL DEFAULT '{}',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Dados de clientes usados pelo functionCalling
            CREATE TABLE IF NOT EXISTS clients_data (
                phone       TEXT PRIMARY KEY,
                data        JSONB NOT NULL DEFAULT '{}',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Lead memory forte para o fluxo comercial
            CREATE TABLE IF NOT EXISTS leads (
                lead_id     TEXT PRIMARY KEY,
                data        JSONB NOT NULL DEFAULT '{}',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Agendamentos
            CREATE TABLE IF NOT EXISTS appointments (
                id          TEXT PRIMARY KEY,
                phone       TEXT NOT NULL,
                name        TEXT NOT NULL,
                date        TEXT NOT NULL,
                time        TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'confirmed',
                type        TEXT NOT NULL DEFAULT 'consultation',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Log de auditoria / LGPD
            CREATE TABLE IF NOT EXISTS audit_log (
                id          SERIAL PRIMARY KEY,
                action      TEXT NOT NULL,
                phone       TEXT,
                details     JSONB,
                timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Consentimentos LGPD
            CREATE TABLE IF NOT EXISTS consents (
                id              SERIAL PRIMARY KEY,
                phone           TEXT NOT NULL,
                consent_type    TEXT NOT NULL,
                active          BOOLEAN NOT NULL DEFAULT TRUE,
                granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                revoked_at      TIMESTAMPTZ
            );

            -- Histórico completo de conversas (mensagens individuais)
            CREATE TABLE IF NOT EXISTS conversations (
                id          SERIAL PRIMARY KEY,
                phone       TEXT NOT NULL,
                role        TEXT NOT NULL,
                message     TEXT NOT NULL,
                media_type  TEXT DEFAULT 'text',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Deduplicação de mensagens WhatsApp (evita reprocessar retransmissões)
            CREATE TABLE IF NOT EXISTS mensagens_processadas (
                message_id    TEXT PRIMARY KEY,
                processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- FASE 1: Playbooks de respostas bem-sucedidas (Self-Improvement)
            CREATE TABLE IF NOT EXISTS agent_interactions (
                id              SERIAL PRIMARY KEY,
                phone           TEXT NOT NULL,
                agent_used      TEXT NOT NULL,
                intention_type  TEXT NOT NULL,
                user_message    TEXT NOT NULL,
                sofia_response  TEXT NOT NULL,
                success         BOOLEAN,
                confidence      NUMERIC(4,3),
                signals         JSONB DEFAULT '[]'::jsonb,
                latency_ms      INTEGER,
                lead_stage      TEXT,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        console.log('✅ Tabelas criadas\n');

        // Índices para performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_appointments_date   ON appointments(date);
            CREATE INDEX IF NOT EXISTS idx_appointments_phone  ON appointments(phone);
            CREATE INDEX IF NOT EXISTS idx_audit_phone         ON audit_log(phone);
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp     ON audit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_consents_phone      ON consents(phone);
            CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
            CREATE INDEX IF NOT EXISTS idx_conversations_time  ON conversations(created_at);
            CREATE INDEX IF NOT EXISTS idx_msg_proc_em         ON mensagens_processadas(processado_em);
            CREATE INDEX IF NOT EXISTS idx_leads_updated_at    ON leads(updated_at);
            CREATE INDEX IF NOT EXISTS idx_agent_interactions_phone  ON agent_interactions(phone);
            CREATE INDEX IF NOT EXISTS idx_agent_interactions_agent  ON agent_interactions(agent_used);
            CREATE INDEX IF NOT EXISTS idx_agent_interactions_time   ON agent_interactions(created_at);
        `);

        console.log('✅ Índices criados\n');
        console.log('🎉 Migrations concluídas! Volte o Start Command para: node index.js');

    } finally {
        client.release();
        await pool.end();
    }
}

runMigrations().catch(err => {
    console.error('❌ Erro nas migrations:', err.message);
    process.exit(1);
});

module.exports = { runMigrations };
