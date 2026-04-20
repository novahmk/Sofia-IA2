/**
 * auth.js — Autenticação JWT para o dashboard
 * Suporta signup, login, verificação de token e middleware de autenticação.
 * Armazena usuários em memória + persiste no PostgreSQL (Railway).
 * Fallback para arquivo JSON apenas quando DATABASE_URL não está configurada.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const USERS_FILE = path.join(__dirname, 'dashboard_users.json');

// JWT_SECRET DEVE ser definido em .env — nunca gerado dinamicamente (tokens seriam invalidados a cada restart)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ CRÍTICO: JWT_SECRET não configurado. Defina em .env ou nas variáveis do Railway.');
    // Em produção sobe mesmo sem JWT_SECRET (dashboard ficará indisponível), mas não derruba o bot
    // process.exit(1) seria adequado se o dashboard for obrigatório
}
const JWT_EXPIRY = '8h';

// Roles: admin (tudo), atendente (sem segurança/AB), visualizador (somente leitura)
const VALID_ROLES = ['admin', 'atendente', 'visualizador'];

// PostgreSQL pool (reutiliza DATABASE_URL do Railway)
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
// Railway usa certificado SSL interno — rejectUnauthorized deve ser false
const pool = hasDatabaseUrl
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    })
    : null;

let users = [];

// Inicialização: cria tabela + hidrata cache
const authReady = (async () => {
    if (pool) {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS dashboard_users (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'visualizador',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            const { rows } = await pool.query('SELECT * FROM dashboard_users');
            users = rows.map(r => ({
                id: r.id,
                name: r.name,
                email: r.email,
                passwordHash: r.password_hash,
                salt: r.salt,
                role: r.role,
                createdAt: r.created_at,
            }));
            console.log(`🔐 Auth: ${users.length} usuário(s) carregado(s) do PostgreSQL`);
        } catch (e) {
            console.error('❌ Auth: Falha ao hidratar usuários do PostgreSQL:', e.message);
            users = loadUsersFromFile();
        }
    } else {
        users = loadUsersFromFile();
    }
})();

function loadUsersFromFile() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const loaded = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
            console.log(`🔐 Auth: ${loaded.length} usuário(s) carregado(s) do arquivo local`);
            return loaded;
        }
    } catch (e) {
        console.warn('⚠️ Erro ao carregar usuários do dashboard:', e.message);
    }
    return [];
}

function saveUsers() {
    // Salva no arquivo local (fallback/dev)
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('❌ Erro ao salvar usuários no arquivo:', e.message);
    }
}

function persistUserToDb(user) {
    if (!pool) return;
    pool.query(
        `INSERT INTO dashboard_users (id, email, name, password_hash, salt, role, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           salt = EXCLUDED.salt,
           role = EXCLUDED.role`,
        [user.id, user.email, user.name, user.passwordHash, user.salt, user.role, user.createdAt]
    ).catch(e => console.error('❌ Auth: Erro ao persistir usuário no PostgreSQL:', e.message));
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
    persistUserToDb(user);
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

// Rotas POST/DELETE que o visualizador nunca deve acessar
const VISUALIZADOR_BLOCKED_PATHS = [
    '/api/dashboard/handoff',
    '/api/dashboard/lgpd',
    '/api/dashboard/kb',
    '/api/dashboard/security',
    '/api/auth/signup',
];

/**
 * Verifica se o role do usuário tem permissão para a rota + método HTTP.
 */
function hasPermission(role, route, method = 'GET') {
    if (role === 'admin') return true;
    if (role === 'atendente') {
        // Atendente não acessa segurança e AB test
        if (route.includes('security') || route.includes('ab-test')) return false;
        return true;
    }
    if (role === 'visualizador') {
        // Visualizador é estritamente read-only: bloqueia todos os POST/DELETE/PUT/PATCH
        if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(method)) return false;
        // Bloqueia rotas sensíveis mesmo em GET
        if (VISUALIZADOR_BLOCKED_PATHS.some(p => route.startsWith(p))) return false;
        return true;
    }
    return false;
}

module.exports = { signup, login, verifyToken, authenticate, hasPermission, JWT_SECRET, authReady };
