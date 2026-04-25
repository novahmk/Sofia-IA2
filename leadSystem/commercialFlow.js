const leadMemory = require('./leadMemory');
const followUpManager = require('./followUpManager');
const { processarQualificacao } = require('./qualificacaoCapilar');
const scoringEngine = require('./leadScoringEngine');

// Lazy require para evitar problema de circular dependency no boot
let _getSofiaResponse = null;
function getSofiaFn() {
  if (!_getSofiaResponse) {
    _getSofiaResponse = require('../ai').getSofiaResponse;
  }
  return _getSofiaResponse;
}

class CommercialFlow {
  async processMessage(phone, userMessage, name = 'Cliente') {
    // 1. Carrega / cria o lead no banco
    await leadMemory.getOrCreateLead(phone, name);

    // 2. Persiste a mensagem do usuário no histórico do lead
    await leadMemory.saveContext(phone, userMessage, true);

    const lead = await leadMemory.getOrCreateLead(phone, name);
    const historicoConversa = lead.contexto_conversa || [];
    const followUpReason = await followUpManager.registrarInteracao(phone, userMessage, lead);

    // 3. Processa qualificação capilar progressiva (substitui regex)
    const qualificationResult = await processarQualificacao(lead, userMessage, historicoConversa);
    if (qualificationResult.status === 'ok') {
      lead.etapa_funil = qualificationResult.etapaFunil;
      lead.qualificacao = qualificationResult.qualificacao;
    }

    // 4. Monta bloco [CONTEXTO DO LEAD] com nome, etapa e histórico recente
    const historico = historicoConversa
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Sofia'}: ${m.content}`)
      .join('\n');

    const qualificacao = lead.qualificacao || {};

    const leadContext = [
      '[CONTEXTO DO LEAD]',
      `Nome: ${lead.nome}`,
      `Etapa do funil: ${lead.etapa_funil}`,
      `Lead score: ${lead.lead_score ?? lead.score ?? 0}`,
      `Temperatura: ${lead.temperatura || 'cold'}`,
      `Nível de qualificação: ${qualificacao.nivel_qualificacao || 'novo'}`,
      `Interesse principal: ${qualificacao.interesse_principal || 'não identificado'}`,
      `Tempo do problema: ${qualificacao.tempo_problema || 'não informado'}`,
      `Urgência: ${qualificacao.urgencia || 'não identificada'}`,
      `Follow-ups realizados: ${lead.follow_up_count || 0}`,
      historico ? `\nHistórico recente:\n${historico}` : '',
      '[FIM DO CONTEXTO]',
    ].filter(Boolean).join('\n');

    // 5. Chama getSofiaResponse() — o cérebro real — passando o contexto do lead
    let response;
    if (qualificationResult.status === 'ok' && qualificationResult.proximaPergunta) {
      response = qualificationResult.proximaPergunta;
    } else {
      const sofiaFn = getSofiaFn();
      response = await sofiaFn(phone, userMessage, leadContext);
    }

    // 6. Persiste a resposta e atualiza etapa no banco
    await leadMemory.saveContext(phone, response, false);
    await leadMemory.updateLead(phone, {
      etapa_funil: lead.etapa_funil,
      qualificacao: lead.qualificacao,
    });

    setImmediate(() => {
      scoringEngine.calcularScore(phone)
        .then((scoreInfo) => {
          if (scoreInfo) {
            console.log(`[scoring] ${phone}: score=${scoreInfo.score}, temp=${scoreInfo.temperatura}`);
          }
        })
        .catch((err) => console.error('[scoring] Erro:', err.message));
    });

    // 7. Reinicia a sequência de sem_resposta a partir da última interação relevante
    if (!followUpReason && ['novo', 'em_qualificacao'].includes(lead.etapa_funil)) {
      await followUpManager.iniciarSequencia(phone, 'sem_resposta');
    }

    return { response, lead: await leadMemory.getOrCreateLead(phone) };
  }
}

module.exports = Object.assign(new CommercialFlow(), { processarQualificacao });