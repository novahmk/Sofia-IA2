/**
 * PLAYBOOK STORAGE — Respostas que funcionaram
 * ══════════════════════════════════════════════════════════
 * Armazena em memória + persiste em playbooks.json
 * Estrutura de cada playbook:
 * {
 *   id, pattern, normalizedPattern, intentionType,
 *   response, successRate, usageCount, successCount,
 *   createdAt, lastUsedAt
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_PATH = path.join(__dirname, '..', 'playbooks.json');

// Limiar mínimo de similaridade para reutilizar um playbook
const SIMILARITY_THRESHOLD = 0.60;

// Taxa mínima de sucesso para reutilizar um playbook
const SUCCESS_RATE_THRESHOLD = 0.75;

class PlaybookStorage {
  constructor() {
    this._byIntention = {}; // Map<intentionType, PlaybookEntry[]>
    this._load();
  }

  // ── Leitura ──────────────────────────────────────────────

  /**
   * Encontra playbook mais similar para reutilização
   * @param {string} userMessage
   * @param {string} intentionType
   * @returns {PlaybookEntry|null}
   */
  findSimilar(userMessage, intentionType) {
    const candidates = this._byIntention[intentionType] || [];
    if (candidates.length === 0) return null;

    const normalMsg = this._normalize(userMessage);
    let best = null;
    let bestScore = 0;

    for (const pb of candidates) {
      if (pb.successRate < SUCCESS_RATE_THRESHOLD) continue;
      const score = this._similarity(normalMsg, pb.normalizedPattern);
      if (score > bestScore) {
        bestScore = score;
        best = pb;
      }
    }

    if (bestScore >= SIMILARITY_THRESHOLD) {
      // Atualiza stats de uso
      best.usageCount += 1;
      best.lastUsedAt = new Date().toISOString();
      this._saveLazy();
      return best;
    }

    return null;
  }

  /**
   * Retorna top N playbooks por taxa de sucesso
   */
  getTop(n = 10) {
    const all = Object.values(this._byIntention).flat();
    return all
      .sort((a, b) => b.successRate - a.successRate || b.usageCount - a.usageCount)
      .slice(0, n);
  }

  // ── Escrita ──────────────────────────────────────────────

  /**
   * Salva novo playbook (ou atualiza existente se padrão similar já existe)
   */
  save({ pattern, response, intentionType, successRate }) {
    if (!pattern || !response || !intentionType) return;

    const normalizedPattern = this._normalize(pattern);

    // Verificar se já existe um similar para não duplicar
    const existing = (this._byIntention[intentionType] || []).find(
      (pb) => this._similarity(normalizedPattern, pb.normalizedPattern) > 0.85
    );

    if (existing) {
      // Média ponderada com novo sucesso
      existing.successCount += successRate >= 0.8 ? 1 : 0;
      existing.usageCount += 1;
      existing.successRate = existing.successCount / existing.usageCount;
      existing.lastUsedAt = new Date().toISOString();
    } else {
      const entry = {
        id: crypto.randomUUID(),
        pattern,
        normalizedPattern,
        intentionType,
        response,
        successRate,
        usageCount: 1,
        successCount: successRate >= 0.8 ? 1 : 0,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };

      if (!this._byIntention[intentionType]) {
        this._byIntention[intentionType] = [];
      }
      this._byIntention[intentionType].push(entry);
    }

    this._saveLazy();
  }

  /**
   * Registra falha em um playbook (diminui taxa de sucesso)
   */
  registerFailure(userMessage, intentionType) {
    const normalMsg = this._normalize(userMessage);
    const candidates = this._byIntention[intentionType] || [];

    for (const pb of candidates) {
      if (this._similarity(normalMsg, pb.normalizedPattern) > 0.75) {
        pb.usageCount += 1;
        pb.successRate = pb.successCount / pb.usageCount;
        pb.lastUsedAt = new Date().toISOString();
        break;
      }
    }

    this._saveLazy();
  }

  // ── Persistência ─────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(FILE_PATH)) {
        const raw = fs.readFileSync(FILE_PATH, 'utf8');
        const data = JSON.parse(raw);
        this._byIntention = data || {};
        const total = Object.values(this._byIntention).flat().length;
        if (total > 0) {
          console.log(`📖 PlaybookStorage: ${total} playbooks carregados`);
        }
      }
    } catch (e) {
      console.warn(`⚠️ PlaybookStorage: falha ao carregar: ${e.message}`);
      this._byIntention = {};
    }
  }

  _saveTimer = null;
  _saveLazy() {
    // Debounce: salva no máximo 1x a cada 5s para não bater no disco todo momento
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.writeFileSync(FILE_PATH, JSON.stringify(this._byIntention, null, 2), 'utf8');
      } catch (e) {
        console.warn(`⚠️ PlaybookStorage: falha ao salvar: ${e.message}`);
      }
    }, 5000);
  }

  // ── Helpers ───────────────────────────────────────────────

  _normalize(str) {
    return (str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Similaridade Jaccard sobre bigrams */
  _similarity(a, b) {
    const bigrams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };

    const setA = bigrams(a);
    const setB = bigrams(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const bg of setA) {
      if (setB.has(bg)) intersection++;
    }

    return intersection / (setA.size + setB.size - intersection);
  }
}

module.exports = new PlaybookStorage();
