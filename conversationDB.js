'use strict';
/**
 * conversationDB.js — Camada de persistência de conversas no PostgreSQL
 *
 * Responsabilidades:
 * - Gravar e carregar histórico de mensagens (tabela `conversations`)
 * - Deduplicação de mensagens pelo ID do WhatsApp (tabela `mensagens_processadas`)
 * - Detecção de contexto frio (gap > N horas sem atividade)
 */

const db = require('./database');

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES || '20', 10);
const COLD_CONTEXT_HOURS = parseFloat(process.env.COLD_CONTEXT_HOURS || '4');

/**
 * Carrega os últimos N turnos de uma conversa do PostgreSQL.
 * @param {string} telefone
 * @param {number} [limite]
 * @returns {Promise<Array<{role: string, conteudo: string}>>}
 */
async function carregarHistorico(telefone, limite = MAX_HISTORY) {
  try {
    const result = await db.query(
      `SELECT role, message AS conteudo
         FROM conversations
        WHERE phone = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [telefone, limite]
    );
    return (result?.rows || []).reverse();
  } catch (e) {
    console.warn(`⚠️ [conversationDB] carregarHistorico: ${e.message}`);
    return [];
  }
}

/**
 * Persiste uma mensagem no PostgreSQL.
 * @param {string} telefone
 * @param {'user'|'assistant'} role
 * @param {string} conteudo
 * @param {string} [tipo='text']
 */
async function salvarMensagem(telefone, role, conteudo, tipo = 'text') {
  if (!telefone || !role || !conteudo) return;
  try {
    await db.query(
      `INSERT INTO conversations (phone, role, message, media_type)
       VALUES ($1, $2, $3, $4)`,
      [telefone, role, String(conteudo).substring(0, 4000), tipo]
    );
  } catch (e) {
    console.warn(`⚠️ [conversationDB] salvarMensagem: ${e.message}`);
  }
}

/**
 * Verifica se uma mensagem já foi processada (deduplicação).
 * @param {string} messageId — ID da mensagem do WhatsApp (key.id)
 * @returns {Promise<boolean>}
 */
async function jaFoiProcessada(messageId) {
  if (!messageId) return false;
  try {
    const result = await db.query(
      `SELECT 1 FROM mensagens_processadas WHERE message_id = $1`,
      [messageId]
    );
    return (result?.rows?.length || 0) > 0;
  } catch (e) {
    // Tabela pode não existir ainda durante inicialização — não bloquear
    return false;
  }
}

/**
 * Marca uma mensagem como processada para evitar reprocessamento.
 * @param {string} messageId
 */
async function marcarComoProcessada(messageId) {
  if (!messageId) return;
  try {
    await db.query(
      `INSERT INTO mensagens_processadas (message_id)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [messageId]
    );
  } catch (e) {
    console.warn(`⚠️ [conversationDB] marcarComoProcessada: ${e.message}`);
  }
}

/**
 * Retorna o timestamp da última mensagem de um número.
 * @param {string} telefone
 * @returns {Promise<Date|null>}
 */
async function getUltimaMensagem(telefone) {
  try {
    const result = await db.query(
      `SELECT created_at
         FROM conversations
        WHERE phone = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [telefone]
    );
    return result?.rows?.[0]?.created_at || null;
  } catch (e) {
    return null;
  }
}

async function getHorasDeContextoFrio(telefone) {
  try {
    const ultima = await getUltimaMensagem(telefone);
    if (!ultima) return null;
    const horasParado = (Date.now() - new Date(ultima).getTime()) / 3_600_000;
    return horasParado >= COLD_CONTEXT_HOURS ? Math.round(horasParado) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Injeta instrução de contexto frio no system prompt quando o lead ficou
 * mais de COLD_CONTEXT_HOURS horas sem responder.
 * @param {string} systemPrompt
 * @param {string} telefone
 * @returns {Promise<string>}
 */
async function injetarContextoFrio(systemPrompt, telefone) {
  try {
    const horasParado = await getHorasDeContextoFrio(telefone);
    if (horasParado) {
      return (
        systemPrompt +
        `\n\n[RETOMADA DE CONVERSA: Este lead ficou ${horasParado}h sem responder. ` +
        `Retome com gentileza, resgate brevemente o interesse anterior e ` +
        `ofereça um caminho claro para o próximo passo. Não repita perguntas já feitas.]`
      );
    }
  } catch (e) { /* não crítico */ }
  return systemPrompt;
}

module.exports = {
  carregarHistorico,
  salvarMensagem,
  jaFoiProcessada,
  marcarComoProcessada,
  getHorasDeContextoFrio,
  injetarContextoFrio,
};
