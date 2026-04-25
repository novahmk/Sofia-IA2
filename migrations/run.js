'use strict';

/**
 * migrations/run.js
 * Executa o bootstrap base e depois aplica as migrations 01-07 em ordem.
 * Uso: node migrations/run.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATION_FILES = [
  '01_expand_leads.sql',
  '02_agendamentos_robusto.sql',
  '03_lead_score_history.sql',
  '04_follow_up_history.sql',
  '05_propostas.sql',
  '06_remarketing_campaigns.sql',
  '07_indexes.sql',
];

let migrationRunPromise = null;
let poolClosed = false;

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL nao configurada. Nao foi possivel executar as migrations.');
  }

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function closePoolOnce(pool) {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
}

async function ensureBaseSchema(client) {
  console.log('[migration] Garantindo schema base existente...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS client_memories (
      phone TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_states (
      phone TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clients_data (
      phone TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      lead_id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      type TEXT NOT NULL DEFAULT 'consultation',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      phone TEXT,
      details JSONB,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS consents (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      consent_type TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      media_type TEXT DEFAULT 'text',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mensagens_processadas (
      message_id TEXT PRIMARY KEY,
      processado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agendamentos_retorno (
      id SERIAL PRIMARY KEY,
      telefone TEXT NOT NULL,
      retornar_em TIMESTAMPTZ NOT NULL,
      motivo TEXT,
      executado BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_interactions (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      agent_used TEXT NOT NULL,
      intention_type TEXT NOT NULL,
      user_message TEXT NOT NULL,
      sofia_response TEXT NOT NULL,
      success BOOLEAN,
      confidence NUMERIC(4,3),
      signals JSONB DEFAULT '[]'::jsonb,
      latency_ms INTEGER,
      lead_stage TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
    CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
    CREATE INDEX IF NOT EXISTS idx_audit_phone ON audit_log(phone);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_consents_phone ON consents(phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_time ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_proc_em ON mensagens_processadas(processado_em);
    CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON leads(updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_interactions_phone ON agent_interactions(phone);
    CREATE INDEX IF NOT EXISTS idx_agent_interactions_agent ON agent_interactions(agent_used);
    CREATE INDEX IF NOT EXISTS idx_agent_interactions_time ON agent_interactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_agend_retorno_telefone ON agendamentos_retorno(telefone);
    CREATE INDEX IF NOT EXISTS idx_agend_retorno_exec ON agendamentos_retorno(executado, retornar_em);
  `);

  const leadColumns = [
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'novo'`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS intencao TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS procedimento_interesse TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS resumo_conversa TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS primeiro_contato TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS ultimo_contato TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS agendado_em TIMESTAMPTZ`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count_new INTEGER DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_proximo TIMESTAMPTZ`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS redirecionado_comercial BOOLEAN DEFAULT FALSE`
  ];

  for (const sql of leadColumns) {
    await client.query(sql);
  }
}

function readMigration(fileName) {
  return fs.readFileSync(path.join(__dirname, fileName), 'utf8');
}

async function runMigrationFile(client, fileName) {
  const sql = readMigration(fileName);
  if (!sql.trim()) {
    console.log(`[migration] Pulando ${fileName} (arquivo vazio)`);
    return;
  }

  console.log(`[migration] Executando ${fileName}...`);
  await client.query(sql);
  console.log(`[migration] OK ${fileName}`);
}

async function runMigrations() {
  if (migrationRunPromise) return migrationRunPromise;

  migrationRunPromise = (async () => {
    const pool = createPool();
    const client = await pool.connect();

    try {
      console.log('[migration] Iniciando migrations...');
      await ensureBaseSchema(client);

      for (const fileName of MIGRATION_FILES) {
        await runMigrationFile(client, fileName);
      }

      console.log('[migration] Todas as migrations foram concluídas com sucesso.');
    } finally {
      client.release();
      await closePoolOnce(pool);
    }
  })();

  return migrationRunPromise;
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error(`[migration] Falha: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  MIGRATION_FILES,
  ensureBaseSchema,
  runMigrations,
};