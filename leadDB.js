'use strict';
/**
 * leadDB.js — Operações de lead usando as colunas nativas da tabela `leads`
 *
 * Complementa leadMemory.js (que usa coluna JSONB `data`) expondo
 * leitura/escrita das colunas estruturadas adicionadas pela migration.
 */

const db = require('./database');

/**
 * Busca ou cria um lead na tabela `leads`.
 * Retorna o objeto JSONB (`data`) mergeado com as colunas nativas.
 * @param {string} telefone
 * @returns {Promise<object>}
 */
async function buscarOuCriarLead(telefone) {
  try {
    const { rows } = await db.query(
      `SELECT lead_id,
              data,
              status,
              intencao,
              score,
              procedimento_interesse,
              resumo_conversa,
              primeiro_contato,
              ultimo_contato,
              agendado_em,
              follow_up_count_new,
              follow_up_proximo,
              redirecionado_comercial
         FROM leads
        WHERE lead_id = $1`,
      [telefone]
    );

    if (rows.length > 0) {
      const r = rows[0];
      return {
        ...(r.data || {}),
        telefone,
        status: r.status || 'novo',
        intencao: r.intencao || null,
        score: r.score ?? 0,
        procedimento_interesse: r.procedimento_interesse || null,
        resumo_conversa: r.resumo_conversa || null,
        primeiro_contato: r.primeiro_contato,
        ultimo_contato: r.ultimo_contato,
        agendado_em: r.agendado_em,
        follow_up_count: r.follow_up_count_new ?? 0,
        follow_up_proximo: r.follow_up_proximo,
        redirecionado_comercial: r.redirecionado_comercial ?? false,
      };
    }

    // Criar novo lead
    await db.query(
      `INSERT INTO leads (lead_id, data, status, score, primeiro_contato, ultimo_contato)
       VALUES ($1, $2::jsonb, 'novo', 0, NOW(), NOW())
       ON CONFLICT (lead_id) DO NOTHING`,
      [telefone, JSON.stringify({ telefone, nome: null })]
    );

    return {
      telefone,
      status: 'novo',
      intencao: null,
      score: 0,
      procedimento_interesse: null,
      resumo_conversa: null,
      follow_up_count: 0,
      follow_up_proximo: null,
      redirecionado_comercial: false,
    };
  } catch (e) {
    console.warn(`⚠️ [leadDB] buscarOuCriarLead: ${e.message}`);
    return { telefone, status: 'novo', score: 0, follow_up_count: 0, redirecionado_comercial: false };
  }
}

/**
 * Atualiza colunas de um lead.
 * @param {string} telefone
 * @param {object} campos — qualquer subset de: status, intencao, score,
 *   procedimento_interesse, resumo_conversa, agendado_em, follow_up_count,
 *   follow_up_proximo, redirecionado_comercial, nome
 */
async function atualizarLead(telefone, campos) {
  if (!campos || Object.keys(campos).length === 0) return;

  const sets = [];
  const vals = [];
  let i = 1;

  const map = {
    status: 'status',
    intencao: 'intencao',
    score: 'score',
    procedimento_interesse: 'procedimento_interesse',
    resumo_conversa: 'resumo_conversa',
    agendado_em: 'agendado_em',
    follow_up_count: 'follow_up_count_new',
    follow_up_proximo: 'follow_up_proximo',
    redirecionado_comercial: 'redirecionado_comercial',
  };

  for (const [key, col] of Object.entries(map)) {
    if (key in campos && campos[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      vals.push(campos[key]);
    }
  }

  // Nome vai para dentro do JSONB `data`
  if (campos.nome) {
    sets.push(`data = data || $${i++}::jsonb`);
    vals.push(JSON.stringify({ nome: campos.nome }));
  }

  sets.push(`ultimo_contato = NOW()`);
  vals.push(telefone);

  if (sets.length === 1) return; // só o ultimo_contato, nada a atualizar

  try {
    await db.query(
      `UPDATE leads SET ${sets.join(', ')} WHERE lead_id = $${i}`,
      vals
    );
  } catch (e) {
    console.warn(`⚠️ [leadDB] atualizarLead: ${e.message}`);
  }
}

/**
 * Atualiza apenas o timestamp de último contato.
 */
async function atualizarUltimoContato(telefone) {
  try {
    await db.query(
      `UPDATE leads SET ultimo_contato = NOW() WHERE lead_id = $1`,
      [telefone]
    );
  } catch (e) { /* não crítico */ }
}

/**
 * Agenda um retorno para o lead em uma data/hora específica.
 * @param {string} telefone
 * @param {string|Date} retornarEm — ISO string ou Date
 * @param {string} [motivo]
 */
async function agendarRetorno(telefone, retornarEm, motivo = null) {
  if (!retornarEm) return;
  try {
    await db.query(
      `INSERT INTO agendamentos_retorno (telefone, retornar_em, motivo)
       VALUES ($1, $2, $3)`,
      [telefone, new Date(retornarEm), motivo]
    );
    console.log(`📅 [leadDB] Retorno agendado para ${telefone} em ${retornarEm}`);
  } catch (e) {
    console.warn(`⚠️ [leadDB] agendarRetorno: ${e.message}`);
  }
}

/**
 * Cancela follow-ups pendentes quando o lead responde.
 */
async function cancelarFollowUpPendente(telefone) {
  try {
    await db.query(
      `UPDATE leads SET follow_up_proximo = NULL WHERE lead_id = $1`,
      [telefone]
    );
  } catch (e) { /* não crítico */ }
}

/**
 * Retorna leads que precisam de follow-up agora.
 * @returns {Promise<Array>}
 */
async function getLeadsParaFollowUp() {
  try {
    const { rows } = await db.query(`
      SELECT lead_id AS telefone,
             data,
             status,
             intencao,
             score,
             procedimento_interesse,
             resumo_conversa,
             follow_up_count_new AS follow_up_count,
             redirecionado_comercial
        FROM leads
       WHERE status IN ('morno', 'frio', 'novo')
         AND follow_up_count_new < 3
         AND follow_up_proximo <= NOW()
         AND redirecionado_comercial = FALSE
    `);
    return rows.map(r => ({ ...r, ...(r.data || {}), telefone: r.telefone }));
  } catch (e) {
    console.warn(`⚠️ [leadDB] getLeadsParaFollowUp: ${e.message}`);
    return [];
  }
}

/**
 * Retorna agendamentos de retorno não executados que já venceram.
 * @returns {Promise<Array>}
 */
async function getAgendamentosParaExecutar() {
  try {
    const { rows } = await db.query(`
      SELECT * FROM agendamentos_retorno
       WHERE retornar_em <= NOW()
         AND executado = FALSE
    `);
    return rows;
  } catch (e) {
    console.warn(`⚠️ [leadDB] getAgendamentosParaExecutar: ${e.message}`);
    return [];
  }
}

/**
 * Marca um agendamento de retorno como executado.
 */
async function marcarRetornoExecutado(id) {
  try {
    await db.query(`UPDATE agendamentos_retorno SET executado = TRUE WHERE id = $1`, [id]);
  } catch (e) { /* não crítico */ }
}

/**
 * Marca lead como redirecionado para o comercial.
 */
async function marcarRedirecionadoComercial(telefone) {
  try {
    await db.query(`
      UPDATE leads SET
          status = 'inativo',
          redirecionado_comercial = TRUE,
          ultimo_contato = NOW()
       WHERE lead_id = $1
    `, [telefone]);
  } catch (e) {
    console.warn(`⚠️ [leadDB] marcarRedirecionadoComercial: ${e.message}`);
  }
}

module.exports = {
  buscarOuCriarLead,
  atualizarLead,
  atualizarUltimoContato,
  agendarRetorno,
  cancelarFollowUpPendente,
  getLeadsParaFollowUp,
  getAgendamentosParaExecutar,
  marcarRetornoExecutado,
  marcarRedirecionadoComercial,
};
