/**
 * metrics-calculator.js — Utilitários de cálculo de métricas analíticas
 *
 * Funções puras para:
 *   - Estatísticas descritivas (média, mediana, desvio padrão, min, max)
 *   - Detecção de tendência (subindo / descendo / estável)
 *   - Variação percentual entre dois valores
 *   - Geração de alertas por threshold
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// ESTATÍSTICAS DESCRITIVAS
// ─────────────────────────────────────────────────────────────

/**
 * Calcula a média aritmética de um array de números.
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
    if (!values || values.length === 0) return 0;
    const nums = values.filter(v => typeof v === 'number' && isFinite(v));
    if (nums.length === 0) return 0;
    return nums.reduce((acc, v) => acc + v, 0) / nums.length;
}

/**
 * Calcula a mediana de um array de números.
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    if (!values || values.length === 0) return 0;
    const nums = values.filter(v => typeof v === 'number' && isFinite(v)).slice().sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

/**
 * Calcula o desvio padrão amostral de um array de números.
 * @param {number[]} values
 * @returns {number}
 */
function stdDev(values) {
    if (!values || values.length < 2) return 0;
    const nums = values.filter(v => typeof v === 'number' && isFinite(v));
    if (nums.length < 2) return 0;
    const avg = mean(nums);
    const variance = nums.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / (nums.length - 1);
    return Math.sqrt(variance);
}

/**
 * Retorna o valor mínimo de um array de números.
 * @param {number[]} values
 * @returns {number}
 */
function min(values) {
    if (!values || values.length === 0) return 0;
    const nums = values.filter(v => typeof v === 'number' && isFinite(v));
    if (nums.length === 0) return 0;
    return Math.min(...nums);
}

/**
 * Retorna o valor máximo de um array de números.
 * @param {number[]} values
 * @returns {number}
 */
function max(values) {
    if (!values || values.length === 0) return 0;
    const nums = values.filter(v => typeof v === 'number' && isFinite(v));
    if (nums.length === 0) return 0;
    return Math.max(...nums);
}

/**
 * Retorna um resumo estatístico completo de um array de números.
 * @param {number[]} values
 * @returns {{ mean: number, median: number, stdDev: number, min: number, max: number, count: number }}
 */
function summarize(values) {
    const nums = (values || []).filter(v => typeof v === 'number' && isFinite(v));
    return {
        mean: mean(nums),
        median: median(nums),
        stdDev: stdDev(nums),
        min: min(nums),
        max: max(nums),
        count: nums.length,
    };
}

// ─────────────────────────────────────────────────────────────
// TENDÊNCIA
// ─────────────────────────────────────────────────────────────

/**
 * Detecta a tendência de uma série temporal usando regressão linear simples.
 *
 * @param {number[]} values  — série ordenada do mais antigo ao mais recente
 * @param {number}   [threshold=0.02]  — variação mínima (2 %) para considerar tendência
 * @returns {{ direction: 'up'|'down'|'stable', slope: number, changePercent: number }}
 */
function detectTrend(values, threshold = 0.02) {
    const nums = (values || []).filter(v => typeof v === 'number' && isFinite(v));
    if (nums.length < 2) return { direction: 'stable', slope: 0, changePercent: 0 };

    const n = nums.length;
    const xMean = (n - 1) / 2;
    const yMean = mean(nums);

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
        numerator += (i - xMean) * (nums[i] - yMean);
        denominator += Math.pow(i - xMean, 2);
    }

    const slope = denominator !== 0 ? numerator / denominator : 0;
    const changePercent = yMean !== 0 ? (slope * (n - 1)) / Math.abs(yMean) : 0;

    let direction = 'stable';
    if (changePercent > threshold) direction = 'up';
    else if (changePercent < -threshold) direction = 'down';

    return {
        direction,
        slope: parseFloat(slope.toFixed(4)),
        changePercent: parseFloat((changePercent * 100).toFixed(2)),
    };
}

// ─────────────────────────────────────────────────────────────
// VARIAÇÃO PERCENTUAL
// ─────────────────────────────────────────────────────────────

/**
 * Calcula a variação percentual entre dois valores.
 * Retorna 0 quando o valor anterior é zero (evita divisão por zero).
 *
 * @param {number} previous
 * @param {number} current
 * @returns {number}  — ex: 12.5 significa +12,5 %
 */
function percentChange(previous, current) {
    if (typeof previous !== 'number' || typeof current !== 'number') return 0;
    if (previous === 0) return current === 0 ? 0 : 100;
    return parseFloat((((current - previous) / Math.abs(previous)) * 100).toFixed(2));
}

// ─────────────────────────────────────────────────────────────
// ALERTAS POR THRESHOLD
// ─────────────────────────────────────────────────────────────

/**
 * Definição de um threshold de alerta.
 * @typedef {{ metric: string, label: string, warnAbove?: number, critAbove?: number, warnBelow?: number, critBelow?: number, unit?: string }} ThresholdDef
 */

/** Thresholds padrão para as métricas da Sofia IA */
const DEFAULT_THRESHOLDS = [
    { metric: 'avgResponseTimeMs', label: 'Tempo médio de resposta', warnAbove: 8000,  critAbove: 15000, unit: 'ms' },
    { metric: 'errorRate',         label: 'Taxa de erros',           warnAbove: 5,     critAbove: 15,    unit: '%'  },
    { metric: 'activeSessions',    label: 'Sessões ativas',          warnAbove: 50,    critAbove: 100,   unit: ''   },
    { metric: 'totalMessages',     label: 'Mensagens (24h)',         warnBelow: 1,     critBelow: 0,     unit: ''   },
    { metric: 'conversionRate',    label: 'Taxa de conversão',       warnBelow: 5,     critBelow: 1,     unit: '%'  },
];

/**
 * Avalia um conjunto de métricas contra thresholds e retorna alertas ativos.
 *
 * @param {Object}           metrics     — objeto com valores numéricos das métricas
 * @param {ThresholdDef[]}   [thresholds=DEFAULT_THRESHOLDS]
 * @returns {{ level: 'warn'|'crit', metric: string, label: string, value: number, threshold: number, unit: string }[]}
 */
function generateAlerts(metrics, thresholds = DEFAULT_THRESHOLDS) {
    const alerts = [];

    for (const def of thresholds) {
        const value = metrics[def.metric];
        if (typeof value !== 'number' || !isFinite(value)) continue;

        if (def.critAbove !== undefined && value >= def.critAbove) {
            alerts.push({ level: 'crit', metric: def.metric, label: def.label, value, threshold: def.critAbove, unit: def.unit || '' });
        } else if (def.warnAbove !== undefined && value >= def.warnAbove) {
            alerts.push({ level: 'warn', metric: def.metric, label: def.label, value, threshold: def.warnAbove, unit: def.unit || '' });
        }

        if (def.critBelow !== undefined && value <= def.critBelow) {
            alerts.push({ level: 'crit', metric: def.metric, label: def.label, value, threshold: def.critBelow, unit: def.unit || '' });
        } else if (def.warnBelow !== undefined && value <= def.warnBelow) {
            alerts.push({ level: 'warn', metric: def.metric, label: def.label, value, threshold: def.warnBelow, unit: def.unit || '' });
        }
    }

    return alerts;
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
    mean,
    median,
    stdDev,
    min,
    max,
    summarize,
    detectTrend,
    percentChange,
    generateAlerts,
    DEFAULT_THRESHOLDS,
};
