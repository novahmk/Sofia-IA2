/**
 * Database Layer — PostgreSQL
 * Mantém a mesma API pública do módulo SQLite anterior para que os outros
 * módulos (conversationManager, clientMemory, auditLogger, functionCalling)
 * não precisem ser alterados.
 *
 * Variável obrigatória no Railway: DATABASE_URL (injetada automaticamente
 * quando você adiciona o plugin PostgreSQL ao projeto).
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Helper interno — executa uma query e devolve o result do pg
async function _query(text, params = []) {
    const client = await pool.connect();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
}

const KV_TABLES = new Set(['client_memories', 'conversation_states', 'clients_data']);

function _assertKvTable(table) {
    if (!KV_TABLES.has(table)) throw new Error(`Tabela inválida: ${table}`);
}

class SofiaDatabase {
    get(table, phone) {
        _assertKvTable(table);
        return _query(`SELECT data FROM ${table} WHERE phone = $1`, [phone])
            .then(r => r.rows[0] ? r.rows[0].data : null)
            .catch(err => { console.error(`[db.get] ${err.message}`); return null; });
    }

    set(table, phone, data) {
        _assertKvTable(table);
        const json = typeof data === 'string' ? data : JSON.stringify(data);
        return _query(
            `INSERT INTO ${table} (phone, data, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (phone) DO UPDATE
               SET data = $2::jsonb, updated_at = NOW()`,
            [phone, json]
        ).catch(err => console.error(`[db.set] ${err.message}`));
    }

    getAll(table) {
        _assertKvTable(table);
        return _query(`SELECT phone, data FROM ${table}`)
            .then(r => {
                const result = {};
                for (const row of r.rows) result[row.phone] = row.data;
                return result;
            })
            .catch(err => { console.error(`[db.getAll] ${err.message}`); return {}; });
    }

    delete(table, phone) {
        _assertKvTable(table);
        return _query(`DELETE FROM ${table} WHERE phone = $1`, [phone])
            .catch(err => console.error(`[db.delete] ${err.message}`));
    }

    getAppointments() {
        return _query('SELECT * FROM appointments ORDER BY date, time')
            .then(r => r.rows)
            .catch(err => { console.error(`[db.getAppointments] ${err.message}`); return []; });
    }

    getAppointmentsByDate(date) {
        return _query('SELECT * FROM appointments WHERE date = $1', [date])
            .then(r => r.rows)
            .catch(err => { console.error(`[db.getAppointmentsByDate] ${err.message}`); return []; });
    }

    getAppointmentBySlot(date, time) {
        return _query('SELECT * FROM appointments WHERE date = $1 AND time = $2', [date, time])
            .then(r => r.rows[0] || null)
            .catch(err => { console.error(`[db.getAppointmentBySlot] ${err.message}`); return null; });
    }

    insertAppointment(appointment) {
        return _query(
            `INSERT INTO appointments (id, phone, name, date, time, status, type, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [
                appointment.id, appointment.phone, appointment.name,
                appointment.date, appointment.time,
                appointment.status || 'confirmed',
                appointment.type || 'consultation',
                appointment.created_at || new Date().toISOString()
            ]
        ).catch(err => console.error(`[db.insertAppointment] ${err.message}`));
    }

    logAudit(action, phone, details) {
        const detailsJson = typeof details === 'string' ? details : JSON.stringify(details);
        return _query(
            'INSERT INTO audit_log (action, phone, details) VALUES ($1, $2, $3)',
            [action, phone || null, detailsJson]
        ).catch(err => console.error(`[db.logAudit] ${err.message}`));
    }

    getAuditLog(phone = null, limit = 50) {
        if (phone) {
            return _query(
                'SELECT * FROM audit_log WHERE phone = $1 ORDER BY timestamp DESC LIMIT $2',
                [phone, limit]
            ).then(r => r.rows).catch(err => { console.error(`[db.getAuditLog] ${err.message}`); return []; });
        }
        return _query(
            'SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT $1',
            [limit]
        ).then(r => r.rows).catch(err => { console.error(`[db.getAuditLog] ${err.message}`); return []; });
    }

    async deleteAllClientData(phone) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM client_memories WHERE phone = $1', [phone]);
            await client.query('DELETE FROM conversation_states WHERE phone = $1', [phone]);
            await client.query('DELETE FROM clients_data WHERE phone = $1', [phone]);
            await client.query('DELETE FROM appointments WHERE phone = $1', [phone]);
            await client.query('DELETE FROM consents WHERE phone = $1', [phone]);
            await client.query(
                'INSERT INTO audit_log (action, phone, details) VALUES ($1, $2, $3)',
                ['LGPD_DATA_DELETION', phone, 'Todos os dados do cliente foram apagados']
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[db.deleteAllClientData] ${err.message}`);
            throw err;
        } finally {
            client.release();
        }
    }

    async getStats() {
        try {
            const [clients, conversations, appointments, auditEntries] = await Promise.all([
                _query('SELECT COUNT(*) AS count FROM client_memories'),
                _query('SELECT COUNT(*) AS count FROM conversation_states'),
                _query('SELECT COUNT(*) AS count FROM appointments'),
                _query('SELECT COUNT(*) AS count FROM audit_log'),
            ]);
            return {
                clients: parseInt(clients.rows[0].count, 10),
                conversations: parseInt(conversations.rows[0].count, 10),
                appointments: parseInt(appointments.rows[0].count, 10),
                auditEntries: parseInt(auditEntries.rows[0].count, 10),
                provider: 'postgresql',
            };
        } catch (err) {
            console.error(`[db.getStats] ${err.message}`);
            return {};
        }
    }

    close() {
        return pool.end().then(() => console.log('🗄️  Database PostgreSQL fechado'));
    }
}

const db = new SofiaDatabase();

_query('SELECT 1')
    .then(() => console.log('🗄️  Database PostgreSQL conectado'))
    .catch(err => console.error(`❌ Falha ao conectar no PostgreSQL: ${err.message} — Defina DATABASE_URL no Railway`));

module.exports = db;
