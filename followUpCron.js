'use strict';
/**
 * followUpCron.js — Follow-up automatizado + retornos agendados
 *
 * Cron 1: A cada hora (9h-18h, seg-sáb)
 *   - Busca leads mornos/frios com follow_up_proximo vencido
 *   - Executa sequência de 3 mensagens via IA
 *   - Após 3 tentativas → redireciona para o time comercial
 *
 * Cron 2: A cada 15 minutos (9h-18h)
 *   - Executa agendamentos de retorno solicitados pelo lead
 *     Ex: "me chama amanhã de manhã"
 */

const cron = require('node-cron');
const { OpenAI } = require('openai');
const leadDB = require('./leadDB');
const { salvarMensagem } = require('./conversationDB');

// Funções de envio são injetadas pelo index.js para evitar dependência circular
let _enviarMensagem = null;

function init(enviarMensagemFn) {
  _enviarMensagem = enviarMensagemFn;
  _iniciarCrons();
  console.log('⏰ [followUpCron] Crons iniciados');
}

// ── Sequência de follow-up ──────────────────────────────────────────────────
const SEQUENCIA_FOLLOWUP = [
  {
    dia: 1,
    tom: 'leve',
    objetivo: 'Reabrir conversa',
    instrucao: 'Envie uma mensagem leve e curiosa para reabrir a conversa. Não mencione agendamento diretamente. Seja breve (máx 2 frases).',
  },
  {
    dia: 2,
    tom: 'consultivo',
    objetivo: 'Gerar valor + urgência',
    instrucao: 'Envie conteúdo de valor sobre o procedimento de interesse + crie urgência sutil. Máximo 3 frases.',
  },
  {
    dia: 4,
    tom: 'encerramento',
    objetivo: 'Quebra de padrão',
    instrucao: 'Mensagem curta e direta. Diga que vai encerrar o contato mas que a porta está aberta. Máximo 2 frases.',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function dentroDoHorarioComercial() {
  // América/Sao_Paulo — UTC-3
  const agora = new Date();
  const hora = new Date(agora.getTime() - 3 * 3600000).getUTCHours();
  return hora >= 9 && hora < 18;
}

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function gerarMensagemFollowUp(lead, etapa) {
  const prompt = `Você é Sofia, consultora da Clínica Quality Hair.
Contexto do lead:
- Nome: ${lead.nome || lead.telefone}
- Status: ${lead.status}
- Interesse: ${lead.procedimento_interesse || 'não identificado'}
- Resumo: ${lead.resumo_conversa || 'sem resumo'}

Objetivo desta mensagem: ${etapa.objetivo}
Tom: ${etapa.tom}
Instrução: ${etapa.instrucao}

Responda APENAS com o texto da mensagem. Sem aspas, sem introdução.`;

  try {
    const openai = getOpenAI();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 120,
    });
    return res.choices[0].message.content.trim();
  } catch (e) {
    console.warn(`⚠️ [followUpCron] gerarMensagemFollowUp falhou: ${e.message}`);
    return null;
  }
}

async function processarFollowUp(lead) {
  const idx = lead.follow_up_count ?? 0;
  const etapa = SEQUENCIA_FOLLOWUP[idx];

  if (!etapa) {
    // Esgotou as tentativas → redirecionar para comercial
    await redirecionarParaComercial(lead);
    return;
  }

  const mensagem = await gerarMensagemFollowUp(lead, etapa);
  if (!mensagem) return;

  await _enviarMensagem(lead.telefone, mensagem);
  await salvarMensagem(lead.telefone, 'assistant', mensagem, 'text');

  const proximoIdx = idx + 1;
  const proximaEtapa = SEQUENCIA_FOLLOWUP[proximoIdx];
  const proximaData = proximaEtapa
    ? new Date(Date.now() + proximaEtapa.dia * 86_400_000)
    : null;

  await leadDB.atualizarLead(lead.telefone, {
    follow_up_count: proximoIdx,
    follow_up_proximo: proximaData,
    status: lead.status === 'novo' ? 'morno' : lead.status,
  });

  console.log(`📤 [followUpCron] Follow-up ${proximoIdx}/${SEQUENCIA_FOLLOWUP.length} enviado para ${lead.telefone}`);
}

async function redirecionarParaComercial(lead) {
  const numeroComercial = process.env.NUMERO_COMERCIAL;

  const resumo = [
    '🚨 *Lead não convertido — Ação necessária*',
    '',
    `👤 *Lead:* ${lead.nome || lead.telefone}`,
    `📱 *Telefone:* ${lead.telefone}`,
    `💉 *Interesse:* ${lead.procedimento_interesse || 'Não identificado'}`,
    `🌡️ *Status:* ${lead.status}`,
    `📊 *Score:* ${lead.score ?? 0}/100`,
    `📝 *Resumo:* ${lead.resumo_conversa || 'Sem resumo'}`,
  ].join('\n');

  try {
    await _enviarMensagem(lead.telefone, 'Obrigada pelo seu contato! Caso queira retomar a conversa, estamos aqui. 😊');
    if (numeroComercial) {
      await _enviarMensagem(numeroComercial, resumo);
    }
  } catch (e) {
    console.warn(`⚠️ [followUpCron] Erro ao redirecionar: ${e.message}`);
  }

  await leadDB.marcarRedirecionadoComercial(lead.telefone);
  console.log(`🚨 [followUpCron] Lead ${lead.telefone} redirecionado para comercial`);
}

async function gerarMensagemRetorno(ag) {
  const prompt = `Você é Sofia, consultora da Clínica Quality Hair.
O lead ${ag.telefone} pediu para ser contactado agora.
Motivo/contexto registrado: "${ag.motivo || 'retorno agendado pelo lead'}".
Escreva uma mensagem amigável e natural para retomar o contato. Máximo 2 frases.`;

  try {
    const openai = getOpenAI();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 80,
    });
    return res.choices[0].message.content.trim();
  } catch (e) {
    return 'Olá! Conforme combinado, estou te retornando 😊 Como posso te ajudar?';
  }
}

// ── Crons ───────────────────────────────────────────────────────────────────

function _iniciarCrons() {
  // Cron 1: follow-ups a cada hora em dias úteis + sábado, 9h-18h
  cron.schedule('0 9-18 * * 1-6', async () => {
    if (!dentroDoHorarioComercial()) return;
    if (!_enviarMensagem) return;

    console.log('[followUpCron] Verificando leads para follow-up...');
    try {
      const leads = await leadDB.getLeadsParaFollowUp();
      console.log(`[followUpCron] ${leads.length} lead(s) para follow-up`);
      for (const lead of leads) {
        await processarFollowUp(lead).catch(e =>
          console.warn(`⚠️ [followUpCron] Erro no lead ${lead.telefone}: ${e.message}`)
        );
      }
    } catch (e) {
      console.warn(`⚠️ [followUpCron] Erro geral: ${e.message}`);
    }
  });

  // Cron 2: retornos agendados a cada 15 minutos
  cron.schedule('*/15 * * * *', async () => {
    if (!dentroDoHorarioComercial()) return;
    if (!_enviarMensagem) return;

    try {
      const agendamentos = await leadDB.getAgendamentosParaExecutar();
      for (const ag of agendamentos) {
        const mensagem = await gerarMensagemRetorno(ag);
        await _enviarMensagem(ag.telefone, mensagem);
        await salvarMensagem(ag.telefone, 'assistant', mensagem, 'text');
        await leadDB.marcarRetornoExecutado(ag.id);
        console.log(`📞 [followUpCron] Retorno executado para ${ag.telefone}`);
      }
    } catch (e) {
      console.warn(`⚠️ [followUpCron] Erro no cron de retornos: ${e.message}`);
    }
  });
}

module.exports = { init, redirecionarParaComercial };
