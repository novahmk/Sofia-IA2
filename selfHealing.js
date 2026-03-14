/**
 * Self-Healing System
 * Sistema de auto-análise e auto-correção de erros da Sofia
 * Detecta padrões de erro, tenta recuperação automática e aprende com falhas
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const HEALING_LOG_FILE = path.join(__dirname, 'healing_log.json');

class SelfHealing {
    constructor() {
        this.errorPatterns = {};  // Rastreia padrões de erro por tipo
        this.healingLog = [];     // Log de ações de recuperação
        this.circuitBreakers = {}; // Circuit breakers por serviço

        // Estratégias de recuperação mapeadas por padrão de erro
        this.recoveryStrategies = {
            // ===== ERROS DE API OPENAI =====
            'rate_limit': {
                detect: (err) => /rate.?limit|429|too.?many.?requests/i.test(err.message || err),
                recover: async (ctx) => {
                    const backoff = Math.min(2000 * Math.pow(2, ctx.attempt), 60000);
                    this._log('rate_limit', `Aguardando ${backoff}ms antes de retry (tentativa ${ctx.attempt + 1})`);
                    await this._sleep(backoff);
                    return { action: 'retry', delay: backoff };
                },
                maxRetries: 4
            },

            'api_timeout': {
                detect: (err) => /timeout|ETIMEDOUT|ECONNABORTED/i.test(err.message || err),
                recover: async (ctx) => {
                    const backoff = 3000 * (ctx.attempt + 1);
                    this._log('api_timeout', `Timeout detectado. Retry em ${backoff}ms (tentativa ${ctx.attempt + 1})`);
                    await this._sleep(backoff);
                    return { action: 'retry', delay: backoff };
                },
                maxRetries: 3
            },

            'api_overloaded': {
                detect: (err) => /overloaded|503|capacity|server.?error|500/i.test(err.message || err),
                recover: async (ctx) => {
                    const backoff = 5000 * Math.pow(2, ctx.attempt);
                    this._log('api_overloaded', `API sobrecarregada. Aguardando ${backoff}ms`);
                    await this._sleep(backoff);
                    return { action: 'retry', delay: backoff };
                },
                maxRetries: 3
            },

            'invalid_api_key': {
                detect: (err) => /invalid.?api.?key|401|authentication|unauthorized/i.test(err.message || err),
                recover: async () => {
                    this._log('invalid_api_key', 'API key inválida — sem recuperação automática possível');
                    return { action: 'abort', reason: 'API key inválida. Verificar .env' };
                },
                maxRetries: 0
            },

            'context_length': {
                detect: (err) => /context.?length|token.?limit|maximum.?context|too.?long/i.test(err.message || err),
                recover: async (ctx) => {
                    this._log('context_length', `Histórico muito longo para ${ctx.phoneNumber}. Podando para 10 mensagens.`);
                    return { action: 'trim_history', keepMessages: 10 };
                },
                maxRetries: 1
            },

            'invalid_response': {
                detect: (err) => /invalid|resposta.?inválida|choices|undefined/i.test(err.message || err),
                recover: async (ctx) => {
                    this._log('invalid_response', `Resposta inválida. Retry com temperatura reduzida (tentativa ${ctx.attempt + 1})`);
                    await this._sleep(1000);
                    return { action: 'retry', adjustments: { temperature: 0.7, max_tokens: 200 } };
                },
                maxRetries: 2
            },

            // ===== ERROS DE MESSAGING =====
            'messaging_send_fail': {
                detect: (err) => /send.?text|send.?message|send.?typing|messaging/i.test(err.message || err),
                recover: async (ctx) => {
                    const backoff = 2000 * (ctx.attempt + 1);
                    this._log('messaging_send_fail', `Falha ao enviar mensagem. Retry em ${backoff}ms`);
                    await this._sleep(backoff);
                    return { action: 'retry', delay: backoff };
                },
                maxRetries: 3
            },

            'messaging_timeout': {
                detect: (err) => /messaging.?timeout|send.?timeout|30s/i.test(err.message || err),
                recover: async (ctx) => {
                    this._log('messaging_timeout', `Messaging timeout. Retry em 5s (tentativa ${ctx.attempt + 1})`);
                    await this._sleep(5000);
                    return { action: 'retry' };
                },
                maxRetries: 2
            },

            // ===== ERROS DE ÁUDIO =====
            'audio_download': {
                detect: (err) => /baixar.?áudio|download|audio.*url|HTTP [45]/i.test(err.message || err),
                recover: async (ctx) => {
                    this._log('audio_download', `Falha no download de áudio. Retry em 3s`);
                    await this._sleep(3000);
                    return { action: 'retry' };
                },
                maxRetries: 2
            },

            'audio_transcription': {
                detect: (err) => /whisper|transcri|audio.*process/i.test(err.message || err),
                recover: async (ctx) => {
                    this._log('audio_transcription', `Falha na transcrição. Retry com temperatura 0`);
                    await this._sleep(2000);
                    return { action: 'retry', adjustments: { temperature: 0 } };
                },
                maxRetries: 2
            },

            // ===== ERROS DE ARQUIVO / JSON =====
            'json_corrupt': {
                detect: (err) => /JSON|parse|SyntaxError|Unexpected/i.test(err.message || err),
                recover: async (ctx) => {
                    this._log('json_corrupt', `Arquivo JSON corrompido: ${ctx.filePath || 'desconhecido'}. Criando backup e resetando.`);
                    if (ctx.filePath && fs.existsSync(ctx.filePath)) {
                        const backupPath = ctx.filePath + `.backup_${Date.now()}`;
                        try {
                            await fsPromises.copyFile(ctx.filePath, backupPath);
                            await fsPromises.writeFile(ctx.filePath, ctx.defaultContent || '{}');
                            this._log('json_corrupt', `Backup salvo em ${backupPath}. Arquivo resetado.`);
                        } catch (writeErr) {
                            this._log('json_corrupt', `Falha ao resetar arquivo: ${writeErr.message}`);
                        }
                    }
                    return { action: 'reset', backupCreated: true };
                },
                maxRetries: 1
            },

            'file_permission': {
                detect: (err) => /EACCES|EPERM|permission/i.test(err.message || err),
                recover: async () => {
                    this._log('file_permission', 'Erro de permissão de arquivo — sem recuperação automática');
                    return { action: 'abort', reason: 'Permissão de arquivo negada' };
                },
                maxRetries: 0
            },

            // ===== ERROS DE REDE =====
            'network': {
                detect: (err) => /ECONNREFUSED|ENOTFOUND|ENETUNREACH|network|DNS/i.test(err.message || err),
                recover: async (ctx) => {
                    const backoff = 5000 * (ctx.attempt + 1);
                    this._log('network', `Erro de rede. Aguardando ${backoff}ms antes de retry`);
                    await this._sleep(backoff);
                    return { action: 'retry', delay: backoff };
                },
                maxRetries: 3
            }
        };
    }

    /**
     * Analisa um erro e tenta recuperação automática
     * @param {Error} error - O erro capturado
     * @param {Function} retryFn - Função para re-executar a operação que falhou
     * @param {Object} ctx - Contexto adicional (phoneNumber, filePath, etc.)
     * @returns {Object} { recovered: bool, result: any, analysis: string }
     */
    async analyze(error, retryFn, ctx = {}) {
        const errorStr = `${error.message || error} ${error.code || ''} ${error.type || ''}`;

        // Identificar a estratégia de recuperação
        const strategy = this._identifyStrategy(errorStr);

        if (!strategy) {
            this._trackUnknownError(error, ctx);
            this._log('unknown', `Erro não reconhecido: ${errorStr.substring(0, 150)}`);
            return { recovered: false, result: null, analysis: `Erro desconhecido: ${error.message}` };
        }

        const { key, config } = strategy;

        // Verificar circuit breaker
        if (this._isCircuitOpen(key)) {
            this._log(key, `Circuit breaker ABERTO para ${key}. Pulando recovery.`);
            return { recovered: false, result: null, analysis: `Circuit breaker aberto para ${key}` };
        }

        // Rastrear padrão de erro
        this._trackErrorPattern(key, error, ctx);

        // Tentar recuperação com retries
        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            try {
                const recoveryResult = await config.recover({ ...ctx, attempt, error });

                if (recoveryResult.action === 'abort') {
                    this._log(key, `Recuperação abortada: ${recoveryResult.reason}`);
                    return { recovered: false, result: null, analysis: recoveryResult.reason };
                }

                if (recoveryResult.action === 'reset') {
                    this._log(key, 'Arquivo resetado com sucesso');
                    return { recovered: true, result: null, analysis: `Arquivo corrigido (backup criado)` };
                }

                if (recoveryResult.action === 'retry' && retryFn) {
                    const retryCtx = { ...ctx, adjustments: recoveryResult.adjustments };
                    const result = await retryFn(retryCtx);
                    this._log(key, `✅ Recuperação bem-sucedida na tentativa ${attempt + 1}`);
                    this._recordHealing(key, attempt + 1, true);
                    return { recovered: true, result, analysis: `Recuperado após ${attempt + 1} tentativa(s)` };
                }

                if (recoveryResult.action === 'trim_history') {
                    return { recovered: true, result: recoveryResult, analysis: 'Histórico podado para reduzir contexto' };
                }

            } catch (retryError) {
                this._log(key, `Tentativa ${attempt + 1} falhou: ${retryError.message}`);
                if (attempt === config.maxRetries) {
                    this._openCircuitBreaker(key);
                    this._recordHealing(key, attempt + 1, false);
                    return { 
                        recovered: false, 
                        result: null, 
                        analysis: `Falha após ${attempt + 1} tentativas. Circuit breaker ativado para ${key}.`
                    };
                }
            }
        }

        return { recovered: false, result: null, analysis: 'Nenhuma estratégia de recuperação disponível' };
    }

    /**
     * Wrapper para executar operação com auto-healing
     * Envolve a função em try/catch e tenta recuperar automaticamente
     */
    async execute(fn, retryFn, ctx = {}) {
        try {
            return await fn();
        } catch (error) {
            console.error(`🔧 Self-Healing: Analisando erro...`);
            const healing = await this.analyze(error, retryFn, ctx);

            if (healing.recovered) {
                console.log(`✅ Self-Healing: ${healing.analysis}`);
                return healing.result;
            }

            console.error(`❌ Self-Healing: Não foi possível recuperar. ${healing.analysis}`);
            throw error; // Re-lançar se não conseguiu recuperar
        }
    }

    // ===== CIRCUIT BREAKER =====

    _isCircuitOpen(key) {
        const cb = this.circuitBreakers[key];
        if (!cb || !cb.open) return false;

        // Auto-reset após 2 minutos
        if (Date.now() - cb.openedAt > 120000) {
            cb.open = false;
            cb.halfOpen = true;
            this._log(key, `Circuit breaker em modo HALF-OPEN (tentando recuperar)`);
            return false;
        }

        return true;
    }

    _openCircuitBreaker(key) {
        this.circuitBreakers[key] = {
            open: true,
            halfOpen: false,
            openedAt: Date.now(),
            failCount: (this.circuitBreakers[key]?.failCount || 0) + 1
        };
        this._log(key, `🔴 Circuit breaker ABERTO (falhas: ${this.circuitBreakers[key].failCount})`);
    }

    // ===== RASTREAMENTO DE PADRÕES =====

    _identifyStrategy(errorStr) {
        for (const [key, config] of Object.entries(this.recoveryStrategies)) {
            if (config.detect(errorStr)) {
                return { key, config };
            }
        }
        return null;
    }

    _trackErrorPattern(key, error, ctx) {
        if (!this.errorPatterns[key]) {
            this.errorPatterns[key] = { count: 0, first: Date.now(), last: null, contexts: [] };
        }

        const pattern = this.errorPatterns[key];
        pattern.count++;
        pattern.last = Date.now();
        pattern.contexts.push({
            phone: ctx.phoneNumber || 'system',
            timestamp: new Date().toISOString(),
            message: (error.message || '').substring(0, 100)
        });

        // Manter no máximo 20 contextos
        if (pattern.contexts.length > 20) {
            pattern.contexts = pattern.contexts.slice(-20);
        }
    }

    _trackUnknownError(error, ctx) {
        this._trackErrorPattern('unknown', error, ctx);
    }

    // ===== RELATÓRIOS =====

    /**
     * Retorna relatório de saúde do sistema de self-healing
     */
    getReport() {
        const report = {
            timestamp: new Date().toISOString(),
            totalHealing: this.healingLog.length,
            successRate: this._calculateSuccessRate(),
            errorPatterns: {},
            circuitBreakers: {},
            recentActions: this.healingLog.slice(-10)
        };

        for (const [key, pattern] of Object.entries(this.errorPatterns)) {
            report.errorPatterns[key] = {
                count: pattern.count,
                firstSeen: new Date(pattern.first).toISOString(),
                lastSeen: pattern.last ? new Date(pattern.last).toISOString() : null,
                frequency: pattern.count > 1 && pattern.last
                    ? `${(pattern.count / ((pattern.last - pattern.first) / 60000)).toFixed(2)}/min`
                    : 'N/A'
            };
        }

        for (const [key, cb] of Object.entries(this.circuitBreakers)) {
            report.circuitBreakers[key] = {
                open: cb.open,
                halfOpen: cb.halfOpen || false,
                failCount: cb.failCount
            };
        }

        return report;
    }

    /**
     * Imprime relatório no console
     */
    printReport() {
        const report = this.getReport();
        console.log('\n🔧 === SELF-HEALING REPORT ===');
        console.log(`📊 Total de recuperações: ${report.totalHealing}`);
        console.log(`✅ Taxa de sucesso: ${report.successRate}%`);

        if (Object.keys(report.errorPatterns).length > 0) {
            console.log('\n📋 Padrões de erro detectados:');
            for (const [key, data] of Object.entries(report.errorPatterns)) {
                console.log(`   ${key}: ${data.count}x (freq: ${data.frequency})`);
            }
        }

        if (Object.keys(report.circuitBreakers).length > 0) {
            console.log('\n🔌 Circuit Breakers:');
            for (const [key, data] of Object.entries(report.circuitBreakers)) {
                const status = data.open ? '🔴 ABERTO' : (data.halfOpen ? '🟡 HALF-OPEN' : '🟢 FECHADO');
                console.log(`   ${key}: ${status} (falhas: ${data.failCount})`);
            }
        }

        console.log('==============================\n');
    }

    // ===== HELPERS =====

    _calculateSuccessRate() {
        if (this.healingLog.length === 0) return '0.00';
        const successes = this.healingLog.filter(l => l.success).length;
        return ((successes / this.healingLog.length) * 100).toFixed(2);
    }

    _recordHealing(errorType, attempts, success) {
        this.healingLog.push({
            errorType,
            attempts,
            success,
            timestamp: new Date().toISOString()
        });

        // Manter no máximo 100 registros
        if (this.healingLog.length > 100) {
            this.healingLog = this.healingLog.slice(-100);
        }

        this._persistLog();
    }

    async _persistLog() {
        try {
            await fsPromises.writeFile(HEALING_LOG_FILE, JSON.stringify({
                errorPatterns: this.errorPatterns,
                healingLog: this.healingLog.slice(-50),
                circuitBreakers: this.circuitBreakers
            }, null, 2));
        } catch (err) {
            // Não falhar silenciosamente em log
        }
    }

    _log(type, message) {
        const timestamp = new Date().toISOString().substring(11, 19);
        console.log(`🔧 [SelfHealing ${timestamp}] [${type}] ${message}`);
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new SelfHealing();
