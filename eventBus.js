/**
 * EVENT BUS — Barramento de eventos interno
 * ══════════════════════════════════════════
 * Publica eventos em memória. O endpoint SSE do webhook
 * se inscreve aqui para fazer streaming para o dashboard.
 *
 * Eventos emitidos:
 *   message_received   { phone, message, timestamp }
 *   agent_routed       { phone, agent, intentionType }
 *   message_sent       { phone, response, agentUsed, latencyMs }
 *   playbook_saved     { intentionType, successRate }
 *   followup_sent      { phone, reason }
 *   stats_update       { agents: {...}, playbooks: N }
 */

'use strict';

const { EventEmitter } = require('events');

class SofiaEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // suporte a múltiplos clientes SSE
  }

  /**
   * Publica evento com timestamp automático
   * @param {string} type
   * @param {object} payload
   */
  publish(type, payload) {
    const event = { type, payload, ts: Date.now() };
    this.emit('event', event);
    this.emit(type, event);
  }
}

module.exports = new SofiaEventBus();
