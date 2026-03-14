/**
 * SWOP - Sofia Watch Over Performance
 * Sistema de monitoramento de erros, latência e performance
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const LOG_FILE = path.join(__dirname, 'sofia.log');

class PerformanceMonitor {
    constructor() {
        this.metrics = {
            totalMessages: 0,
            totalErrors: 0,
            totalLatency: 0,
            avgLatency: 0,
            maxLatency: 0,
            minLatency: Infinity,
            errorLog: [],
            latencyLog: []
        };
        this.startTime = Date.now();
    }

    /**
     * Registra uma requisição e sua latência
     */
    recordLatency(phoneNumber, messageLength, latencyMs, status = 'success') {
        this.metrics.totalMessages++;
        this.metrics.totalLatency += latencyMs;
        this.metrics.avgLatency = (this.metrics.totalLatency / this.metrics.totalMessages).toFixed(2);
        
        if (latencyMs > this.metrics.maxLatency) {
            this.metrics.maxLatency = latencyMs;
        }
        if (latencyMs < this.metrics.minLatency) {
            this.metrics.minLatency = latencyMs;
        }

        const logEntry = {
            timestamp: new Date().toISOString(),
            phoneNumber,
            messageLength,
            latencyMs,
            status
        };

        this.metrics.latencyLog.push(logEntry);

        // Mantém apenas os últimos 100 registros em memória
        if (this.metrics.latencyLog.length > 100) {
            this.metrics.latencyLog.shift();
        }

        // Aviso se latência estiver alta
        if (latencyMs > 5000) {
            this.logWarning(`⚠️ LATÊNCIA ALTA: ${latencyMs}ms para ${phoneNumber}`);
        }

        this.writeToFile(logEntry);
    }

    /**
     * Registra um erro
     */
    recordError(phoneNumber, errorMessage, errorType = 'UNKNOWN') {
        this.metrics.totalErrors++;

        const errorEntry = {
            timestamp: new Date().toISOString(),
            phoneNumber,
            errorType,
            errorMessage: errorMessage.toString(),
            stack: new Error().stack
        };

        this.metrics.errorLog.push(errorEntry);

        // Mantém apenas os últimos 50 erros em memória
        if (this.metrics.errorLog.length > 50) {
            this.metrics.errorLog.shift();
        }

        console.error(`❌ ERRO [${errorType}]: ${phoneNumber} - ${errorMessage}`);
        this.writeToFile(errorEntry);
    }

    /**
     * Registra um aviso
     */
    logWarning(message) {
        const entry = {
            timestamp: new Date().toISOString(),
            type: 'WARNING',
            message
        };
        console.warn(message);
        this.writeToFile(entry);
    }

    /**
     * Escreve no arquivo de log (assíncrono)
     */
    writeToFile(entry) {
        const logLine = JSON.stringify(entry) + '\n';
        fsPromises.appendFile(LOG_FILE, logLine).catch(err => {
            console.error('Erro ao escrever log:', err);
        });
    }

    /**
     * Retorna um relatório de saúde da aplicação
     */
    getHealthReport() {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const errorRate = this.metrics.totalMessages > 0 
            ? ((this.metrics.totalErrors / this.metrics.totalMessages) * 100).toFixed(2)
            : 0;

        return {
            uptime: `${uptime}s`,
            totalMessages: this.metrics.totalMessages,
            totalErrors: this.metrics.totalErrors,
            errorRate: `${errorRate}%`,
            avgLatency: `${this.metrics.avgLatency}ms`,
            maxLatency: `${this.metrics.maxLatency}ms`,
            minLatency: `${this.metrics.minLatency === Infinity ? 'N/A' : this.metrics.minLatency + 'ms'}`,
            recentErrors: this.metrics.errorLog.slice(-5)
        };
    }

    /**
     * Exibe relatório no console
     */
    printHealthReport() {
        const report = this.getHealthReport();
        console.log('\n📊 === SOFIA HEALTH REPORT === 📊');
        console.log(`⏱️  Uptime: ${report.uptime}`);
        console.log(`📨 Total de mensagens: ${report.totalMessages}`);
        console.log(`❌ Total de erros: ${report.totalErrors} (${report.errorRate}%)`);
        console.log(`⚡ Latência média: ${report.avgLatency}`);
        console.log(`⚡ Latência máxima: ${report.maxLatency}`);
        console.log(`⚡ Latência mínima: ${report.minLatency}`);
        console.log('================================\n');
    }
}

module.exports = new PerformanceMonitor();
