/**
 * crypto-utils.js — Utilitários de criptografia para o dashboard seguro
 *
 * Fornece:
 *   - encrypt / decrypt  → AES-256-GCM com IV aleatório e tag de autenticação
 *   - generateKey        → Gera chave aleatória de 32 bytes (hex)
 *   - hashPassword       → bcrypt com salt rounds configurável
 *   - verifyPassword     → bcrypt compare
 *
 * Todos os erros são lançados explicitamente para que o chamador decida
 * como tratá-los (nunca engole silenciosamente).
 */

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ─── Constantes ────────────────────────────────────────────────────────────────
const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH   = 12;   // 96 bits — recomendado para GCM
const TAG_LENGTH  = 16;   // 128 bits — padrão GCM
const KEY_LENGTH  = 32;   // 256 bits
const SALT_ROUNDS = 12;   // bcrypt cost factor

// ─── AES-256-GCM ───────────────────────────────────────────────────────────────

/**
 * Criptografa `data` (string ou objeto) com AES-256-GCM.
 *
 * @param {string|object} data  Dado a criptografar (objetos são JSON.stringify'd)
 * @param {string}        key   Chave hex de 32 bytes (64 chars hex) ou Buffer
 * @returns {{ iv: string, tag: string, ciphertext: string }}
 */
function encrypt(data, key) {
    const keyBuf = _resolveKey(key);
    const iv     = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv, { authTagLength: TAG_LENGTH });

    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag       = cipher.getAuthTag();

    return {
        iv:         iv.toString('hex'),
        tag:        tag.toString('hex'),
        ciphertext: encrypted.toString('hex'),
    };
}

/**
 * Descriptografa o resultado de `encrypt`.
 *
 * @param {{ iv: string, tag: string, ciphertext: string }} encrypted
 * @param {string} key  Chave hex de 32 bytes
 * @returns {string}    Plaintext original
 * @throws {Error}      Se a autenticação falhar (dados adulterados)
 */
function decrypt(encrypted, key) {
    const { iv, tag, ciphertext } = encrypted;
    if (!iv || !tag || !ciphertext) {
        throw new Error('Payload de descriptografia inválido: campos iv, tag e ciphertext são obrigatórios');
    }

    const keyBuf    = _resolveKey(key);
    const decipher  = crypto.createDecipheriv(ALGORITHM, keyBuf, Buffer.from(iv, 'hex'), { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(Buffer.from(tag, 'hex'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'hex')),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

/**
 * Gera uma chave aleatória de 32 bytes codificada em hex (64 caracteres).
 * Use para criar ENCRYPTION_KEY em produção.
 *
 * @returns {string}
 */
function generateKey() {
    return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

// ─── bcrypt ────────────────────────────────────────────────────────────────────

/**
 * Gera hash bcrypt de uma senha.
 *
 * @param {string} password
 * @param {number} [rounds=SALT_ROUNDS]
 * @returns {Promise<string>}
 */
async function hashPassword(password, rounds = SALT_ROUNDS) {
    if (!password || typeof password !== 'string') {
        throw new Error('Senha inválida');
    }
    return bcrypt.hash(password, rounds);
}

/**
 * Verifica se `password` corresponde ao `hash` bcrypt armazenado.
 *
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
    if (!password || !hash) return false;
    return bcrypt.compare(password, hash);
}

// ─── Helpers internos ──────────────────────────────────────────────────────────

/**
 * Converte chave hex ou Buffer para Buffer de 32 bytes.
 * @param {string|Buffer} key
 * @returns {Buffer}
 */
function _resolveKey(key) {
    if (Buffer.isBuffer(key)) {
        if (key.length !== KEY_LENGTH) {
            throw new Error(`Chave deve ter ${KEY_LENGTH} bytes; recebeu ${key.length}`);
        }
        return key;
    }
    if (typeof key === 'string') {
        const buf = Buffer.from(key, 'hex');
        if (buf.length !== KEY_LENGTH) {
            throw new Error(`Chave hex deve ter ${KEY_LENGTH * 2} caracteres; recebeu ${key.length}`);
        }
        return buf;
    }
    throw new Error('Chave deve ser string hex ou Buffer');
}

module.exports = { encrypt, decrypt, generateKey, hashPassword, verifyPassword };
