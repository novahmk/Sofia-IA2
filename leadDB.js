'use strict';
/**
 * leadDB.js — Operações de lead usando as colunas nativas da tabela `leads`
 *
 * Complementa leadMemory.js (que usa coluna JSONB `data`) expondo
 * leitura/escrita das colunas estruturadas adicionadas pela migration.
 */

const db = require('./database');

function getDefaultQualificacao() {
  return {
    interesse_principal: null,
    tempo_problema: null,
    tratamento_anterior: null,
    descricao_tratamento: null,
    urgencia: null,
    decide_sozinho: null,
    abertura_investimento: null,
    objecao_atual: null,
    sentimento: null,
    pronto_para_agendamento: false,
    nivel_qualificacao: 'novo',
    sinais_extraidos_em: null,
  };
}

function mapNivelQualificacaoToEtapa(nivel) {
  switch (nivel) {
    case 'hot':
      return 'hot';
    case 'qualificado':
      return 'qualificado';
    case 'em_qualificacao':
      return 'em_qualificacao';
    default:
      return 'novo';
  }
}

function normalizeQualificacaoCapilar(sinais = {}, nivel = 'novo', previous = {}) {
  const merged = {
    ...getDefaultQualificacao(),
    ...(previous || {}),
  };

  if (sinais.interesse_principal && sinais.interesse_principal !== 'nao_identificado') {
    merged.interesse_principal = sinais.interesse_principal;
  }

  if (sinais.tempo_problema && sinais.tempo_problema !== 'nao_informado') {
    merged.tempo_problema = sinais.tempo_problema;
  }

  if (typeof sinais.tratamento_anterior === 'boolean') {
    merged.tratamento_anterior = sinais.tratamento_anterior;
  }

  if (sinais.urgencia && sinais.urgencia !== 'nao_identificada') {
    merged.urgencia = sinais.urgencia;
  }

  if (typeof sinais.decide_sozinho === 'boolean') {
    merged.decide_sozinho = sinais.decide_sozinho;
  }

  if (sinais.abertura_investimento && sinais.abertura_investimento !== 'nao_informado') {
    merged.abertura_investimento = sinais.abertura_investimento;
  }

  if (sinais.objecao_detectada && sinais.objecao_detectada !== 'nao_identificada') {
    merged.objecao_atual = sinais.objecao_detectada;
  }

  if (sinais.sentimento) {
    merged.sentimento = sinais.sentimento;
  }

  if (typeof sinais.pronto_para_agendamento === 'boolean') {
    merged.pronto_para_agendamento = sinais.pronto_para_agendamento;
  }

  merged.nivel_qualificacao = nivel || previous?.nivel_qualificacao || 'novo';
  merged.sinais_extraidos_em = new Date().toISOString();

  return merged;
}

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
      qualificacao: getDefaultQualificacao(),
      follow_up_count: 0,
      follow_up_proximo: null,
      redirecionado_comercial: false,
    };
  } catch (e) {
    console.warn(`⚠️ [leadDB] buscarOuCriarLead: ${e.message}`);

    const cachedLead = db.get('leads', telefone);
    if (cachedLead) {
      return {
        ...cachedLead,
        telefone,
        status: cachedLead.status || 'novo',
        intencao: cachedLead.intencao || null,
        score: cachedLead.score ?? 0,
        procedimento_interesse: cachedLead.procedimento_interesse || null,
        resumo_conversa: cachedLead.resumo_conversa || null,
        qualificacao: cachedLead.qualificacao || getDefaultQualificacao(),
        follow_up_count: cachedLead.follow_up_count ?? 0,
        follow_up_proximo: cachedLead.follow_up_proximo || null,
        redirecionado_comercial: cachedLead.redirecionado_comercial ?? false,
      };
    }

    const localLead = {
      telefone,
      nome: null,
      status: 'novo',
      intencao: null,
      score: 0,
      procedimento_interesse: null,
      resumo_conversa: null,
      qualificacao: getDefaultQualificacao(),
      follow_up_count: 0,
      follow_up_proximo: null,
      redirecionado_comercial: false,
    };
    db.set('leads', telefone, localLead);

    return {
      ...localLead,
    };
  }
}

/**
 * Atualiza colunas de um lead.
 * @param {string} telefone
 * @param {object} campos — qualquer subset de: status, intencao, score,
 *   procedimento_interesse, resumo_conversa, agendado_em, follow_up_count,
 *   follow_up_proximo, redirecionado_comercial, nome, etapa_funil,
 *   lead_score, temperatura, nivel_qualificacao, motivo_recusa,
 *   segmento_remarketing, tentativas_remarketing, convertido_via_remarketing,
 *   data_conversao
 */
async function atualizarLead(telefone, campos) {
  if (!campos || Object.keys(campos).length === 0) return;

  const sets = [];
  const vals = [];
  let i = 1;

  const map = {
    etapa_funil: 'etapa_funil',
    status: 'status',
    intencao: 'intencao',
    score: 'score',
    lead_score: 'lead_score',
    temperatura: 'temperatura',
    nivel_qualificacao: 'nivel_qualificacao',
    motivo_recusa: 'motivo_recusa',
    segmento_remarketing: 'segmento_remarketing',
    tentativas_remarketing: 'tentativas_remarketing',
    convertido_via_remarketing: 'convertido_via_remarketing',
    data_conversao: 'data_conversao',
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

async function atualizarQualificacaoCapilar(telefone, sinais, nivel) {
  const leadAtual = await buscarOuCriarLead(telefone);
  const qualificacao = normalizeQualificacaoCapilar(sinais, nivel, leadAtual.qualificacao);
  const etapaFunil = mapNivelQualificacaoToEtapa(qualificacao.nivel_qualificacao);

  const payload = {
    qualificacao,
    etapa_funil: etapaFunil,
  };

  if (qualificacao.interesse_principal) {
    payload.interesse_principal = qualificacao.interesse_principal;
  }

  if (qualificacao.tempo_problema) {
    payload.tempo_problema = qualificacao.tempo_problema;
  }

  if (typeof qualificacao.tratamento_anterior === 'boolean') {
    payload.tratamento_anterior = qualificacao.tratamento_anterior;
  }

  if (qualificacao.descricao_tratamento) {
    payload.descricao_tratamento_anterior = qualificacao.descricao_tratamento;
  }

  if (qualificacao.urgencia) {
    payload.urgencia_percebida = qualificacao.urgencia;
  }

  try {
    await db.query(
      `UPDATE leads
          SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
              ultimo_contato = NOW()
        WHERE lead_id = $2`,
      [JSON.stringify(payload), telefone]
    );
  } catch (e) {
    console.warn(`⚠️ [leadDB] atualizarQualificacaoCapilar: ${e.message}`);
  }

  return { qualificacao, etapaFunil };
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
  atualizarQualificacaoCapilar,
};
