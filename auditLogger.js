/**
 * Audit Logger — Logs de Auditoria Completos
 * Registra TODAS as ações do sistema para auditoria, compliance (LGPD) e diagnóstico.
 * Grava em SQLite (tabela audit_log) com fallback para arquivo.
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const AUDIT_FILE = path.join(__dirname, 'audit.log');

// Tipos de ação
const ACTIONS = {
    MSG_RECEIVED: 'MSG_RECEIVED',
    MSG_SENT: 'MSG_SENT',
    AI_CALL: 'AI_CALL',
    AI_RESPONSE: 'AI_RESPONSE',
    FUNCTION_CALLED: 'FUNCTION_CALLED',
    APPOINTMENT_BOOKED: 'APPOINTMENT_BOOKED',
    ESCALATION: 'ESCALATION',
    ERROR: 'ERROR',
    SELF_HEALING: 'SELF_HEALING',
    RATE_LIMITED: 'RATE_LIMITED',
    INPUT_SANITIZED: 'INPUT_SANITIZED',
    TOPIC_BLOCKED: 'TOPIC_BLOCKED',
    LGPD_DELETE: 'LGPD_DELETE',
    LGPD_EXPORT: 'LGPD_EXPORT',
    LGPD_CONSENT: 'LGPD_CONSENT',
    MODE_CHANGE: 'MODE_CHANGE',
    COMMAND: 'COMMAND',
    AB_TEST_ASSIGNED: 'AB_TEST_ASSIGNED',
    STARTUP: 'STARTUP',
    SHUTDOWN: 'SHUTDOWN'
};

class AuditLogger {
    constructor() {
        this.db = null;
        this.buffer = [];        // Buffer para escritas em batch
        this.flushInterval = setInterval(() => this._flush(), 10000);

        // Tentar conectar ao database
        try {
            this.db = require('./database');
        } catch (_) {
            // sem SQLite, usa arquivo
        }
    }

    /**
     * Registra uma ação de auditoria
     * @param {string} action - Tipo de ação (use ACTIONS constantes)
     * @param {string|null} phone - Telefone relacionado (ou null para ações de sistema)
     * @param {object|string} details - Detalhes da ação
     * @param {object} [metadata] - Dados extras (latência, modelo, etc.)
     */
    log(action, phone, details, metadata = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            action,
            phone: phone || 'SYSTEM',
            details: typeof details === 'string' ? details : JSON.stringify(details),
            metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
        };

        // Gravar no SQLite se disponível
        if (this.db) {
            try {
                this.db.logAudit(action, phone, {
                    details: entry.details,
                    ...(entry.metadata ? { metadata: entry.metadata } : {})
                });
            } catch (err) {
                // Fallback: adicionar ao buffer de arquivo
                this.buffer.push(entry);
            }
        } else {
            this.buffer.push(entry);
        }
    }

    // ===== MÉTODOS DE CONVENIÊNCIA =====

    msgReceived(phone, text, mediaType = 'text') {
        this.log(ACTIONS.MSG_RECEIVED, phone, { text: text.substring(0, 200), mediaType });
    }

    msgSent(phone, text) {
        this.log(ACTIONS.MSG_SENT, phone, { text: text.substring(0, 200) });
    }

    aiCall(phone, model, tokensUsed) {
        this.log(ACTIONS.AI_CALL, phone, { model }, { tokensUsed });
    }

    aiResponse(phone, responseTimeMs, hadFunctionCalls) {
        this.log(ACTIONS.AI_RESPONSE, phone, { responseTimeMs, hadFunctionCalls });
    }

    functionCalled(phone, functionName, args, result) {
        this.log(ACTIONS.FUNCTION_CALLED, phone, {
            function: functionName,
            args: JSON.stringify(args).substring(0, 200),
            success: !result?.error
        });
    }

    appointmentBooked(phone, date, time) {
        this.log(ACTIONS.APPOINTMENT_BOOKED, phone, { date, time });
    }

    escalation(phone, reason, priority) {
        this.log(ACTIONS.ESCALATION, phone, { reason, priority });
    }

    error(phone, errorMessage, errorType) {
        this.log(ACTIONS.ERROR, phone, { errorMessage, errorType });
    }

    selfHealing(phone, errorType, recovered, analysis) {
        this.log(ACTIONS.SELF_HEALING, phone, { errorType, recovered, analysis });
    }

    rateLimited(phone, msgCount) {
        this.log(ACTIONS.RATE_LIMITED, phone, { messageCount: msgCount });
    }

    inputSanitized(phone, flags) {
        this.log(ACTIONS.INPUT_SANITIZED, phone, { flags });
    }

    topicBlocked(phone, topic) {
        this.log(ACTIONS.TOPIC_BLOCKED, phone, { topic });
    }

    lgpdDelete(phone, result) {
        this.log(ACTIONS.LGPD_DELETE, phone, result);
    }

    lgpdExport(phone) {
        this.log(ACTIONS.LGPD_EXPORT, phone, 'Dados exportados');
    }

    modeChange(phone, fromMode, toMode) {
        this.log(ACTIONS.MODE_CHANGE, phone, { from: fromMode, to: toMode });
    }

    command(phone, commandName) {
        this.log(ACTIONS.COMMAND, phone, { command: commandName });
    }

    abTestAssigned(phone, variant) {
        this.log(ACTIONS.AB_TEST_ASSIGNED, phone, { variant });
    }

    startup() {
        this.log(ACTIONS.STARTUP, null, { startedAt: new Date().toISOString() });
    }

    shutdown() {
        this.log(ACTIONS.SHUTDOWN, null, { stoppedAt: new Date().toISOString() });
        this._flush();
    }

    // ===== CONSULTAS =====

    /**
     * Busca logs de auditoria (requer SQLite)
     */
    query(phone = null, limit = 100) {
        if (this.db) {
            return this.db.getAuditLog(phone, limit);
        }
        return { error: 'SQLite não disponível. Logs em arquivo: audit.log' };
    }

    /**
     * Retorna resumo de ações
     */
    getReport() {
        if (this.db) {
            try {
                const logs = this.db.getAuditLog(null, 500);
                const actionCounts = {};
                for (const log of logs) {
                    actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
                }
                return {
                    totalEntries: logs.length,
                    actionCounts,
                    latestEntries: logs.slice(0, 10)
                };
            } catch (err) {
                return { error: err.message };
            }
        }
        return { source: 'file', filePath: AUDIT_FILE, bufferSize: this.buffer.length };
    }

    // ===== FLUSH PARA ARQUIVO =====

    async _flush() {
        if (this.buffer.length === 0) return;

        const lines = this.buffer.map(e =>
            `[${e.timestamp}] ${e.action} | ${e.phone} | ${e.details}${e.metadata ? ' | ' + e.metadata : ''}`
        ).join('\n') + '\n';

        this.buffer = [];

        try {
            await fsPromises.appendFile(AUDIT_FILE, lines);
        } catch (err) {
            console.error('❌ Erro ao gravar audit log:', err.message);
        }
    }

    /**
     * Cleanup
     */
    destroy() {
        clearInterval(this.flushInterval);
        this._flush();
    }
}

// Exportar constantes junto
AuditLogger.ACTIONS = ACTIONS;

module.exports = new AuditLogger();
