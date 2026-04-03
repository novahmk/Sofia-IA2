/**
 * auth.js — Autenticação JWT para o dashboard
 * Suporta signup, login, verificação de token e middleware de autenticação.
 * Armazena usuários em memória (com fallback para arquivo JSON).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'dashboard_users.json');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '8h';

// Roles: admin (tudo), atendente (sem segurança/AB), visualizador (somente leitura)
const VALID_ROLES = ['admin', 'atendente', 'visualizador'];

let users = loadUsers();

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
        }
    } catch (e) {
        console.warn('⚠️ Erro ao carregar usuários do dashboard:', e.message);
    }
    return [];
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('❌ Erro ao salvar usuários:', e.message);
    }
}

function hashPassword(password, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
    const { hash } = hashPassword(password, salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function signup({ name, email, password, role }) {
    if (!name || !email || !password) {
        return { error: 'Campos name, email e password são obrigatórios' };
    }
    if (password.length < 8) {
        return { error: 'Senha deve ter no mínimo 8 caracteres' };
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (users.find(u => u.email === normalizedEmail)) {
        return { error: 'Email já cadastrado' };
    }
    if (role && !VALID_ROLES.includes(role)) {
        return { error: `Role inválido. Use: ${VALID_ROLES.join(', ')}` };
    }

    const { hash, salt } = hashPassword(password);
    const user = {
        id: crypto.randomUUID(),
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: hash,
        salt,
        role: role || 'visualizador',
        createdAt: new Date().toISOString(),
    };
    users.push(user);
    saveUsers();
    return { success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

function login({ email, password }) {
    if (!email || !password) {
        return { error: 'Email e senha são obrigatórios' };
    }
    const normalizedEmail = email.toLowerCase().trim();
    const user = users.find(u => u.email === normalizedEmail);
    if (!user) {
        return { error: 'Email ou senha incorretos', status: 401 };
    }
    if (!verifyPassword(password, user.passwordHash, user.salt)) {
        return { error: 'Email ou senha incorretos', status: 401 };
    }
    const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
    return {
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

/**
 * Middleware de autenticação para o servidor HTTP nativo.
 * Retorna o payload do JWT se válido, ou null se inválido.
 * Se inválido, envia response 401 automaticamente.
 */
function authenticate(req, res) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Token não fornecido' }));
        return null;
    }
    const payload = verifyToken(token);
    if (!payload) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Token inválido ou expirado' }));
        return null;
    }
    return payload;
}

/**
 * Verifica se o role do usuário tem permissão para a rota.
 */
function hasPermission(role, route) {
    if (role === 'admin') return true;
    if (role === 'atendente') {
        // Atendente não acessa segurança e AB test
        if (route.includes('security') || route.includes('ab-test')) return false;
        return true;
    }
    if (role === 'visualizador') {
        // Visualizador não pode fazer POST (handoff, kb add, lgpd actions)
        return true; // read-only checked at POST level
    }
    return false;
}

module.exports = { signup, login, verifyToken, authenticate, hasPermission, JWT_SECRET };
