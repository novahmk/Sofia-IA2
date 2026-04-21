/**
 * CONVERSATION ANALYZER — Avalia qualidade de cada interação
 * ══════════════════════════════════════════════════════════
 * Rodado em background (setImmediate), nunca bloqueia a resposta.
 *
 * Usa heurísticas leves (sem chamada GPT) para decidir se a
 * resposta foi provavelmente boa ou ruim. A análise GPT completa
 * é reservada para casos ambíguos onde vale o custo de API.
 */

'use strict';

// Sinais de que a resposta foi BEM recebida (próxima mensagem do cliente)
const POSITIVE_SIGNALS = [
  'ok', 'ótimo', 'perfeito', 'entendi', 'certo', 'show', 'obrigado', 'obrigada',
  'boa', 'legal', 'excelente', 'adorei', 'quero', 'pode ser', 'vou agendar',
  'sim', 'claro', 'aceito', 'fechado', 'vamos',
];

// Sinais de que a resposta foi MAL recebida
const NEGATIVE_SIGNALS = [
  'não entendi', 'confuso', 'não é isso', 'errado', 'não respondi', 'outra coisa',
  'isso não', 'nada a ver', 'chato', 'ruim', 'péssimo', 'desapontado',
  'não era isso', 'me ajuda', 'cadê', 'sumiu', 'nunca mais',
];

// Sinais de conversão (lead avançou no funil)
const CONVERSION_SIGNALS = [
  'agendar', 'marcar', 'quero ir', 'quando posso', 'horário', 'disponível',
  'vou lá', 'confirmo', 'aceito', 'fecha', 'ok vamos',
];

class ConversationAnalyzer {
  /**
   * Analisa se a resposta Sofia foi adequada usando heurísticas locais
   * @param {string} sofiaResponse - resposta que a Sofia deu
   * @param {string|null} nextMessage - próxima mensagem do cliente (se disponível)
   * @param {object} metadata - contexto (agente, intenção, latência)
   * @returns {{ success: boolean|null, confidence: number, signals: string[] }}
   */
  analyzeResponse(sofiaResponse, nextMessage, metadata) {
    const signals = [];
    let positiveScore = 0;
    let negativeScore = 0;

    // Análise da resposta da Sofia
    if (sofiaResponse) {
      const resp = sofiaResponse.toLowerCase();

      // Resposta muito curta (< 10 chars) provavelmente é erro
      if (resp.trim().length < 10) {
        negativeScore += 2;
        signals.push('response_too_short');
      }

      // Resposta sem conteúdo relevante
      if (resp.includes('desculpe') || resp.includes('não consegui') || resp.includes('erro')) {
        negativeScore += 1;
        signals.push('error_in_response');
      }

      // Resposta com call-to-action (bom sinal comercial)
      if (resp.includes('avaliação gratuita') || resp.includes('agendar') || resp.includes('venha')) {
        positiveScore += 1;
        signals.push('has_cta');
      }
    }

    // Análise da próxima mensagem do cliente (se disponível)
    if (nextMessage) {
      const next = nextMessage.toLowerCase();

      const hasPositive = POSITIVE_SIGNALS.some((s) => next.includes(s));
      const hasNegative = NEGATIVE_SIGNALS.some((s) => next.includes(s));
      const hasConversion = CONVERSION_SIGNALS.some((s) => next.includes(s));

      if (hasConversion) {
        positiveScore += 3;
        signals.push('conversion_signal');
      } else if (hasPositive) {
        positiveScore += 2;
        signals.push('positive_reply');
      } else if (hasNegative) {
        negativeScore += 2;
        signals.push('negative_reply');
      }
    }

    // Latência alta pode indicar problema de performance
    if (metadata?.latencyMs > 8000) {
      signals.push('high_latency');
    }

    // Calcular resultado
    if (positiveScore === 0 && negativeScore === 0) {
      // Sem dados suficientes para avaliar
      return { success: null, confidence: 0.5, signals };
    }

    const total = positiveScore + negativeScore;
    const confidence = Math.min(positiveScore / total, 0.99);
    const success = positiveScore > negativeScore;

    return { success, confidence, signals };
  }
}

module.exports = new ConversationAnalyzer();
