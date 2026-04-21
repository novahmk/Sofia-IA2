/**
 * SELF-IMPROVEMENT ENGINE — Motor de aprendizado contínuo
 * ══════════════════════════════════════════════════════════
 * Responsável por:
 * 1. Analisar qualidade de cada interação (background)
 * 2. Salvar playbooks de respostas bem-sucedidas
 * 3. Registrar falhas para análise de padrões
 * 4. Estatísticas de desempenho por agente
 *
 * NUNCA bloqueia o fluxo principal — todo processamento é assíncrono.
 */

'use strict';

const playbookStorage = require('./playbookStorage');
const conversationAnalyzer = require('./conversationAnalyzer');

// Fila em memória: { phone, userMessage, sofiaResponse, metadata, timestamp }[]
const _pendingAnalyses = [];

// Contadores de desempenho por agente (reset a cada hora)
const _agentStats = {};
let _statsResetAt = Date.now();

class SelfImprovementEngine {
  /**
   * Entry point chamado pelo Supervisor após cada resposta.
   * Roda 100% em background via setImmediate.
   *
   * @param {string} phone
   * @param {string} userMessage
   * @param {string} sofiaResponse
   * @param {{ agentUsed, intentionType, latencyMs, leadStage }} metadata
   */
  analyze(phone, userMessage, sofiaResponse, metadata) {
    _pendingAnalyses.push({
      phone,
      userMessage,
      sofiaResponse,
      metadata,
      timestamp: Date.now(),
    });

    // Processa de forma assíncrona sem lançar exceção no caller
    setImmediate(() => this._processLatest().catch(() => {}));
  }

  /**
   * Chamado externamente quando a próxima mensagem do cliente chega.
   * Isso fecha o loop: sabemos como o cliente reagiu à resposta anterior.
   */
  feedNextMessage(phone, nextMessage) {
    // Encontrar análise pendente mais recente deste telefone
    const idx = _pendingAnalyses
      .map((p, i) => (p.phone === phone ? i : -1))
      .filter((i) => i >= 0)
      .pop();

    if (idx === undefined || idx === -1) return;

    const pending = _pendingAnalyses[idx];
    pending.nextMessage = nextMessage;

    setImmediate(() => this._evaluateAndLearn(pending).catch(() => {}));
    _pendingAnalyses.splice(idx, 1);
  }

  /**
   * Retorna estatísticas de desempenho dos agentes
   */
  getStats() {
    this._maybeResetStats();
    return { stats: { ..._agentStats }, since: new Date(_statsResetAt).toISOString() };
  }

  // ── Internos ──────────────────────────────────────────────

  async _processLatest() {
    const entry = _pendingAnalyses[_pendingAnalyses.length - 1];
    if (!entry || entry.nextMessage !== undefined) return;

    // Análise sem nextMessage: baseada apenas na resposta da Sofia
    const result = conversationAnalyzer.analyzeResponse(
      entry.sofiaResponse,
      null,
      entry.metadata
    );

    this._updateStats(entry.metadata.agentUsed, result);

    // Resposta com call-to-action clara → provável sucesso → salva playbook
    if (result.signals.includes('has_cta') && result.confidence >= 0.6) {
      playbookStorage.save({
        pattern: entry.userMessage,
        response: entry.sofiaResponse,
        intentionType: entry.metadata.intentionType,
        successRate: result.confidence,
      });
    }
  }

  async _evaluateAndLearn(entry) {
    const result = conversationAnalyzer.analyzeResponse(
      entry.sofiaResponse,
      entry.nextMessage,
      entry.metadata
    );

    this._updateStats(entry.metadata.agentUsed, result);

    if (result.success === true && result.confidence >= 0.75) {
      console.log(
        `✅ [SelfImprovement] Sucesso (${entry.metadata.agentUsed}, conf: ${result.confidence.toFixed(2)}) → salvando playbook`
      );
      playbookStorage.save({
        pattern: entry.userMessage,
        response: entry.sofiaResponse,
        intentionType: entry.metadata.intentionType,
        successRate: result.confidence,
      });
    } else if (result.success === false) {
      console.log(
        `⚠️ [SelfImprovement] Falha detectada (${entry.metadata.agentUsed}): ${result.signals.join(', ')}`
      );
      playbookStorage.registerFailure(entry.userMessage, entry.metadata.intentionType);
    }
  }

  _updateStats(agent, analysisResult) {
    this._maybeResetStats();
    if (!agent) return;

    if (!_agentStats[agent]) {
      _agentStats[agent] = { total: 0, success: 0, failure: 0, unknown: 0 };
    }

    _agentStats[agent].total += 1;
    if (analysisResult.success === true) _agentStats[agent].success += 1;
    else if (analysisResult.success === false) _agentStats[agent].failure += 1;
    else _agentStats[agent].unknown += 1;
  }

  _maybeResetStats() {
    const ONE_HOUR = 60 * 60 * 1000;
    if (Date.now() - _statsResetAt > ONE_HOUR) {
      Object.keys(_agentStats).forEach((k) => delete _agentStats[k]);
      _statsResetAt = Date.now();
    }
  }
}

module.exports = new SelfImprovementEngine();
