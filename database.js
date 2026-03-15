/**
 * Database Layer — PostgreSQL
 * Expõe uma API síncrona em memória e persiste em background no PostgreSQL.
 * Isso mantém compatibilidade com os módulos existentes, que foram escritos
 * esperando leitura síncrona do banco local.
 */

const { Pool } = require('pg');

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const pool = hasDatabaseUrl
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    })
    : null;

async function _query(text, params = []) {
    if (!pool) {
        throw new Error('DATABASE_URL não configurada');
    }

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

function _serializeJsonb(value) {
    return JSON.stringify(typeof value === 'undefined' ? null : value);
}

class SofiaDatabase {
    constructor() {
        this.kvCache = {
            client_memories: {},
            conversation_states: {},
            clients_data: {},
        };
        this.appointments = [];
        this.auditLog = [];
        this.hydrated = false;

        this.ready = this._hydrate();
    }

    async _hydrate() {
        if (!pool) {
            console.warn('⚠️ PostgreSQL não configurado. Usando cache local em memória.');
            return;
        }

        try {
            const [memories, conversationStates, clientsData, appointments, auditLog] = await Promise.all([
                _query('SELECT phone, data FROM client_memories'),
                _query('SELECT phone, data FROM conversation_states'),
                _query('SELECT phone, data FROM clients_data'),
                _query('SELECT * FROM appointments ORDER BY date, time'),
                _query('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 1000'),
            ]);

            this._replaceKvCache('client_memories', memories.rows);
            this._replaceKvCache('conversation_states', conversationStates.rows);
            this._replaceKvCache('clients_data', clientsData.rows);
            this._replaceArray(this.appointments, appointments.rows);
            this._replaceArray(this.auditLog, auditLog.rows);

            this.hydrated = true;
            console.log('🗄️  Database PostgreSQL conectado e cache carregado');
        } catch (err) {
            console.error(`❌ Falha ao hidratar cache do PostgreSQL: ${err.message}`);
        }
    }

    _replaceKvCache(table, rows) {
        const target = this.kvCache[table];
        for (const key of Object.keys(target)) {
            delete target[key];
        }
        for (const row of rows) {
            target[row.phone] = row.data;
        }
    }

    _replaceArray(target, rows) {
        target.splice(0, target.length, ...rows);
    }

    _runInBackground(promise, label) {
        promise.catch((err) => {
            console.error(`❌ ${label}: ${err.message}`);
        });
    }

    get(table, phone) {
        _assertKvTable(table);
        return this.kvCache[table][phone] || null;
    }

    set(table, phone, data) {
        _assertKvTable(table);
        this.kvCache[table][phone] = data;

        if (!pool) return;

        this._runInBackground(
            _query(
                `INSERT INTO ${table} (phone, data, updated_at)
                 VALUES ($1, $2::jsonb, NOW())
                 ON CONFLICT (phone) DO UPDATE
                   SET data = $2::jsonb, updated_at = NOW()`,
                [phone, _serializeJsonb(data)]
            ),
            `db.set(${table})`
        );
    }

    getAll(table) {
        _assertKvTable(table);
        return this.kvCache[table];
    }

    delete(table, phone) {
        _assertKvTable(table);
        delete this.kvCache[table][phone];

        if (!pool) return;

        this._runInBackground(
            _query(`DELETE FROM ${table} WHERE phone = $1`, [phone]),
            `db.delete(${table})`
        );
    }

    getAppointments() {
        return this.appointments;
    }

    getAppointmentsByDate(date) {
        return this.appointments.filter(appointment => appointment.date === date);
    }

    getAppointmentBySlot(date, time) {
        return this.appointments.find(appointment => appointment.date === date && appointment.time === time) || null;
    }

    insertAppointment(appointment) {
        const existingIndex = this.appointments.findIndex(item => item.id === appointment.id);
        if (existingIndex >= 0) {
            this.appointments[existingIndex] = appointment;
        } else {
            this.appointments.push(appointment);
        }

        if (!pool) return;

        this._runInBackground(
            _query(
                `INSERT INTO appointments (id, phone, name, date, time, status, type, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO UPDATE SET
                   phone = EXCLUDED.phone,
                   name = EXCLUDED.name,
                   date = EXCLUDED.date,
                   time = EXCLUDED.time,
                   status = EXCLUDED.status,
                   type = EXCLUDED.type`,
                [
                    appointment.id,
                    appointment.phone,
                    appointment.name,
                    appointment.date,
                    appointment.time,
                    appointment.status || 'confirmed',
                    appointment.type || 'consultation',
                    appointment.created_at || new Date().toISOString(),
                ]
            ),
            'db.insertAppointment'
        );
    }

    insertConversationMessage(phone, role, message, mediaType = 'text') {
        if (!pool) return;

        this._runInBackground(
            _query(
                `INSERT INTO conversations (phone, role, message, media_type)
                 VALUES ($1, $2, $3, $4)`,
                [phone, role, message, mediaType]
            ),
            'db.insertConversationMessage'
        );
    }

    logAudit(action, phone, details) {
        const entry = {
            action,
            phone: phone || null,
            details,
            timestamp: new Date().toISOString(),
        };

        this.auditLog.unshift(entry);
        if (this.auditLog.length > 1000) {
            this.auditLog.length = 1000;
        }

        if (!pool) return;

        this._runInBackground(
            _query(
                'INSERT INTO audit_log (action, phone, details) VALUES ($1, $2, $3::jsonb)',
                [action, phone || null, _serializeJsonb(details)]
            ),
            'db.logAudit'
        );
    }

    getAuditLog(phone = null, limit = 50) {
        const source = phone
            ? this.auditLog.filter(entry => entry.phone === phone)
            : this.auditLog;

        return source.slice(0, limit);
    }

    deleteAllClientData(phone) {
        delete this.kvCache.client_memories[phone];
        delete this.kvCache.conversation_states[phone];
        delete this.kvCache.clients_data[phone];

        for (let index = this.appointments.length - 1; index >= 0; index -= 1) {
            if (this.appointments[index].phone === phone) {
                this.appointments.splice(index, 1);
            }
        }

        this.logAudit('LGPD_DATA_DELETION', phone, 'Todos os dados do cliente foram apagados');

        if (!pool) return;

        this._runInBackground(
            (async () => {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM client_memories WHERE phone = $1', [phone]);
                    await client.query('DELETE FROM conversation_states WHERE phone = $1', [phone]);
                    await client.query('DELETE FROM clients_data WHERE phone = $1', [phone]);
                    await client.query('DELETE FROM appointments WHERE phone = $1', [phone]);
                    await client.query('DELETE FROM consents WHERE phone = $1', [phone]);
                    await client.query('DELETE FROM conversations WHERE phone = $1', [phone]);
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            })(),
            'db.deleteAllClientData'
        );
    }

    getStats() {
        return {
            clients: Object.keys(this.kvCache.client_memories).length,
            conversations: Object.keys(this.kvCache.conversation_states).length,
            appointments: this.appointments.length,
            auditEntries: this.auditLog.length,
            provider: pool ? 'postgresql' : 'memory',
            hydrated: this.hydrated,
        };
    }

    close() {
        if (!pool) return Promise.resolve();
        return pool.end().then(() => console.log('🗄️  Database PostgreSQL fechado'));
    }
}

module.exports = new SofiaDatabase();
