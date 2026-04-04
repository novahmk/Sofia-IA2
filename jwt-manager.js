/**
 * jwt-manager.js — Gerenciador de JWT com access + refresh tokens
 *
 * Estratégia:
 *   - Access token  → curta duração (15 min), assina com JWT_SECRET
 *   - Refresh token → longa duração (7 dias), assina com JWT_REFRESH_SECRET
 *   - Revogação     → Set em memória (produção: substituir por Redis/DB)
 *
 * Exporta:
 *   generateAccessToken(user)      → string JWT
 *   generateRefreshToken(user)     → string JWT
 *   verifyAccessToken(token)       → payload | null
 *   verifyRefreshToken(token)      → payload | null
 *   revokeRefreshToken(token)      → void
 *   isRefreshTokenRevoked(token)   → boolean
 *   getTokenExpiry(token)          → Date | null
 */

'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

// ─── Segredos ──────────────────────────────────────────────────────────────────
const ACCESS_SECRET  = process.env.JWT_SECRET         || crypto.randomBytes(64).toString('hex');
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(64).toString('hex');

if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET não definido — usando segredo aleatório (tokens inválidos após restart)');
}
if (!process.env.JWT_REFRESH_SECRET) {
    console.warn('⚠️  JWT_REFRESH_SECRET não definido — usando segredo aleatório (tokens inválidos após restart)');
}

// ─── Durações ──────────────────────────────────────────────────────────────────
const ACCESS_EXPIRY  = '15m';
const REFRESH_EXPIRY = '7d';

// ─── Revogação em memória ──────────────────────────────────────────────────────
// Armazena JTI (JWT ID) dos refresh tokens revogados.
// Em produção, substituir por Redis com TTL = expiração do token.
const _revokedTokens = new Set();

// Limpeza periódica de tokens expirados da lista de revogação (a cada hora)
setInterval(() => {
    for (const jti of _revokedTokens) {
        // JTI é "<userId>:<issuedAt>:<random>" — não há como verificar expiração
        // sem decodificar; mantemos o Set pequeno limpando tokens mais antigos
        // que 7 dias (REFRESH_EXPIRY) com base no timestamp embutido no JTI.
        const parts = jti.split(':');
        if (parts.length >= 2) {
            const issuedAt = parseInt(parts[1], 10);
            if (!isNaN(issuedAt) && Date.now() - issuedAt > 7 * 24 * 60 * 60 * 1000) {
                _revokedTokens.delete(jti);
            }
        }
    }
}, 60 * 60 * 1000).unref();

// ─── Geração ───────────────────────────────────────────────────────────────────

/**
 * Gera um access token JWT de curta duração (15 min).
 *
 * @param {{ id: string, email: string, role: string, name: string }} user
 * @returns {string}
 */
function generateAccessToken(user) {
    _assertUser(user);
    return jwt.sign(
        {
            sub:   user.id,
            email: user.email,
            role:  user.role,
            name:  user.name,
            type:  'access',
        },
        ACCESS_SECRET,
        {
            expiresIn: ACCESS_EXPIRY,
            issuer:    'sofia-ia2',
            audience:  'dashboard',
        }
    );
}

/**
 * Gera um refresh token JWT de longa duração (7 dias).
 * Inclui JTI único para suporte a revogação.
 *
 * @param {{ id: string, email: string, role: string, name: string }} user
 * @returns {string}
 */
function generateRefreshToken(user) {
    _assertUser(user);
    const jti = `${user.id}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
    return jwt.sign(
        {
            sub:  user.id,
            role: user.role,
            type: 'refresh',
            jti,
        },
        REFRESH_SECRET,
        {
            expiresIn: REFRESH_EXPIRY,
            issuer:    'sofia-ia2',
            audience:  'dashboard',
        }
    );
}

// ─── Verificação ───────────────────────────────────────────────────────────────

/**
 * Verifica e decodifica um access token.
 *
 * @param {string} token
 * @returns {object|null}  Payload decodificado ou null se inválido/expirado
 */
function verifyAccessToken(token) {
    try {
        const payload = jwt.verify(token, ACCESS_SECRET, {
            issuer:   'sofia-ia2',
            audience: 'dashboard',
        });
        if (payload.type !== 'access') return null;
        return payload;
    } catch {
        return null;
    }
}

/**
 * Verifica e decodifica um refresh token.
 * Retorna null se revogado, expirado ou inválido.
 *
 * @param {string} token
 * @returns {object|null}
 */
function verifyRefreshToken(token) {
    try {
        const payload = jwt.verify(token, REFRESH_SECRET, {
            issuer:   'sofia-ia2',
            audience: 'dashboard',
        });
        if (payload.type !== 'refresh') return null;
        if (payload.jti && _revokedTokens.has(payload.jti)) return null;
        return payload;
    } catch {
        return null;
    }
}

// ─── Revogação ─────────────────────────────────────────────────────────────────

/**
 * Revoga um refresh token adicionando seu JTI à lista negra.
 * Tokens sem JTI são ignorados silenciosamente.
 *
 * @param {string} token
 */
function revokeRefreshToken(token) {
    try {
        // Decodifica sem verificar assinatura para extrair JTI mesmo de tokens expirados
        const decoded = jwt.decode(token);
        if (decoded?.jti) {
            _revokedTokens.add(decoded.jti);
        }
    } catch {
        // Token malformado — nada a revogar
    }
}

/**
 * Verifica se um refresh token foi revogado.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isRefreshTokenRevoked(token) {
    try {
        const decoded = jwt.decode(token);
        if (!decoded?.jti) return false;
        return _revokedTokens.has(decoded.jti);
    } catch {
        return false;
    }
}

// ─── Utilitários ───────────────────────────────────────────────────────────────

/**
 * Retorna a data de expiração de um token (sem verificar assinatura).
 *
 * @param {string} token
 * @returns {Date|null}
 */
function getTokenExpiry(token) {
    try {
        const decoded = jwt.decode(token);
        if (!decoded?.exp) return null;
        return new Date(decoded.exp * 1000);
    } catch {
        return null;
    }
}

// ─── Helpers internos ──────────────────────────────────────────────────────────

function _assertUser(user) {
    if (!user || !user.id || !user.email || !user.role) {
        throw new Error('Usuário inválido: id, email e role são obrigatórios');
    }
}

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    revokeRefreshToken,
    isRefreshTokenRevoked,
    getTokenExpiry,
};
