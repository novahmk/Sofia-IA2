/**
 * Database Layer — SQLite
 * Substitui persistência em JSON por banco de dados real
 * Suporta transações ACID, queries e migração automática
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'sofia.db');

let Database;
try {
    Database = require('better-sqlite3');
} catch (err) {
    console.error('❌ better-sqlite3 não instalado. Execute: npm install better-sqlite3');
    // Fallback: exportar objeto noop para não quebrar o sistema
    module.exports = null;
    return;
}

class SofiaDatabase {
    constructor() {
        this.db = new Database(DB_PATH);
        // WAL mode para melhor performance com leituras concorrentes
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this._createTables();
        this._migrateFromJSON();

        console.log(`🗄️  Database SQLite inicializado: ${DB_PATH}`);
    }

    // ===== SCHEMA =====

    _createTables() {
        this.db.exec(`
            -- Memória de clientes
            CREATE TABLE IF NOT EXISTS client_memories (
                phone TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Estados de conversa
            CREATE TABLE IF NOT EXISTS conversation_states (
                phone TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Agendamentos
            CREATE TABLE IF NOT EXISTS appointments (
                id TEXT PRIMARY KEY,
                phone TEXT NOT NULL,
                name TEXT NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'confirmed',
                type TEXT NOT NULL DEFAULT 'consultation',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Dados de clientes (functionCalling)
            CREATE TABLE IF NOT EXISTS clients_data (
                phone TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Log de auditoria LGPD
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                phone TEXT,
                details TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- Consentimentos LGPD
            CREATE TABLE IF NOT EXISTS consents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT NOT NULL,
                consent_type TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                granted_at TEXT NOT NULL DEFAULT (datetime('now')),
                revoked_at TEXT
            );

            -- Índices para performance
            CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
            CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
            CREATE INDEX IF NOT EXISTS idx_audit_phone ON audit_log(phone);
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_consents_phone ON consents(phone);
        `);
    }

    // ===== MIGRAÇÃO DE JSON PARA SQLITE =====

    _migrateFromJSON() {
        this._migrateFile(
            path.join(__dirname, 'client_memories.json'),
            'client_memories',
            (phone, data) => {
                this._upsert('client_memories', phone, data);
            }
        );

        this._migrateFile(
            path.join(__dirname, 'conversation_states.json'),
            'conversation_states',
            (phone, data) => {
                this._upsert('conversation_states', phone, data);
            }
        );

        this._migrateFile(
            path.join(__dirname, 'clients_data.json'),
            'clients_data',
            (phone, data) => {
                this._upsert('clients_data', phone, data);
            }
        );

        // Migrar appointments (array)
        const aptsFile = path.join(__dirname, 'appointments.json');
        if (fs.existsSync(aptsFile)) {
            try {
                const existing = this.db.prepare('SELECT COUNT(*) as count FROM appointments').get();
                if (existing.count === 0) {
                    const appointments = JSON.parse(fs.readFileSync(aptsFile, 'utf-8'));
                    if (Array.isArray(appointments)) {
                        const insert = this.db.prepare(
                            'INSERT OR IGNORE INTO appointments (id, phone, name, date, time, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                        );
                        const tx = this.db.transaction((apts) => {
                            for (const apt of apts) {
                                insert.run(apt.id, apt.phone, apt.name, apt.date, apt.time, apt.status || 'confirmed', apt.type || 'consultation', apt.created_at || new Date().toISOString());
                            }
                        });
                        tx(appointments);
                        console.log(`   ✅ Migrados ${appointments.length} agendamentos de JSON para SQLite`);
                        fs.renameSync(aptsFile, aptsFile + '.migrated');
                    }
                }
            } catch (err) {
                console.warn(`   ⚠️ Falha ao migrar appointments.json: ${err.message}`);
            }
        }
    }

    _migrateFile(filePath, tableName, insertFn) {
        if (!fs.existsSync(filePath)) return;

        try {
            const existing = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();
            if (existing.count > 0) return; // Já migrado

            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const keys = Object.keys(data);

            if (keys.length === 0) return;

            const tx = this.db.transaction(() => {
                for (const key of keys) {
                    insertFn(key, data[key]);
                }
            });
            tx();

            console.log(`   ✅ Migrados ${keys.length} registros de ${path.basename(filePath)} para SQLite`);
            // Renomear arquivo original para backup
            fs.renameSync(filePath, filePath + '.migrated');
        } catch (err) {
            console.warn(`   ⚠️ Falha ao migrar ${path.basename(filePath)}: ${err.message}`);
        }
    }

    // ===== OPERAÇÕES GENÉRICAS =====

    _upsert(table, phone, data) {
        const json = JSON.stringify(data);
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT INTO ${table} (phone, data, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET data = ?, updated_at = ?
        `).run(phone, json, now, now, json, now);
    }

    /**
     * Obtém registro de uma tabela por telefone
     */
    get(table, phone) {
        const row = this.db.prepare(`SELECT data FROM ${table} WHERE phone = ?`).get(phone);
        return row ? JSON.parse(row.data) : null;
    }

    /**
     * Salva registro em uma tabela
     */
    set(table, phone, data) {
        this._upsert(table, phone, data);
    }

    /**
     * Obtém todos os registros de uma tabela
     */
    getAll(table) {
        const rows = this.db.prepare(`SELECT phone, data FROM ${table}`).all();
        const result = {};
        for (const row of rows) {
            result[row.phone] = JSON.parse(row.data);
        }
        return result;
    }

    /**
     * Remove registro de uma tabela
     */
    delete(table, phone) {
        this.db.prepare(`DELETE FROM ${table} WHERE phone = ?`).run(phone);
    }

    // ===== APPOINTMENTS =====

    getAppointments() {
        return this.db.prepare('SELECT * FROM appointments ORDER BY date, time').all();
    }

    getAppointmentsByDate(date) {
        return this.db.prepare('SELECT * FROM appointments WHERE date = ?').all(date);
    }

    getAppointmentBySlot(date, time) {
        return this.db.prepare('SELECT * FROM appointments WHERE date = ? AND time = ?').get(date, time);
    }

    insertAppointment(appointment) {
        this.db.prepare(
            'INSERT INTO appointments (id, phone, name, date, time, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(appointment.id, appointment.phone, appointment.name, appointment.date, appointment.time, appointment.status, appointment.type, appointment.created_at);
    }

    // ===== AUDITORIA LGPD =====

    logAudit(action, phone, details) {
        this.db.prepare(
            'INSERT INTO audit_log (action, phone, details) VALUES (?, ?, ?)'
        ).run(action, phone, typeof details === 'string' ? details : JSON.stringify(details));
    }

    getAuditLog(phone = null, limit = 50) {
        if (phone) {
            return this.db.prepare('SELECT * FROM audit_log WHERE phone = ? ORDER BY timestamp DESC LIMIT ?').all(phone, limit);
        }
        return this.db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?').all(limit);
    }

    // ===== LGPD — EXCLUSÃO COMPLETA =====

    /**
     * Apaga TODOS os dados de um cliente de TODAS as tabelas
     */
    deleteAllClientData(phone) {
        const tx = this.db.transaction(() => {
            this.db.prepare('DELETE FROM client_memories WHERE phone = ?').run(phone);
            this.db.prepare('DELETE FROM conversation_states WHERE phone = ?').run(phone);
            this.db.prepare('DELETE FROM clients_data WHERE phone = ?').run(phone);
            this.db.prepare('DELETE FROM appointments WHERE phone = ?').run(phone);
            this.db.prepare('DELETE FROM consents WHERE phone = ?').run(phone);
            this.logAudit('LGPD_DATA_DELETION', phone, 'Todos os dados do cliente foram apagados');
        });
        tx();
    }

    // ===== ESTATÍSTICAS =====

    getStats() {
        return {
            clients: this.db.prepare('SELECT COUNT(*) as count FROM client_memories').get().count,
            conversations: this.db.prepare('SELECT COUNT(*) as count FROM conversation_states').get().count,
            appointments: this.db.prepare('SELECT COUNT(*) as count FROM appointments').get().count,
            auditEntries: this.db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count,
            dbSizeMB: (fs.statSync(DB_PATH).size / (1024 * 1024)).toFixed(2)
        };
    }

    /**
     * Fecha a conexão com o banco
     */
    close() {
        this.db.close();
        console.log('🗄️  Database fechado');
    }
}

module.exports = new SofiaDatabase();
