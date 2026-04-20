/**
 * Input Sanitizer
 * Proteção contra prompt injection, XSS e inputs maliciosos
 * Sanitiza toda entrada do usuário antes de processar
 */

// Padrões de prompt injection conhecidos
const INJECTION_PATTERNS = [
    // Tentativas de alterar o system prompt
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /ignore\s+(all\s+)?prior\s+instructions/i,
    /forget\s+(all\s+)?previous/i,
    /disregard\s+(all\s+)?above/i,
    /override\s+system\s+prompt/i,
    /new\s+system\s+prompt/i,
    /you\s+are\s+now/i,
    /act\s+as\s+if/i,
    /pretend\s+(you\s+are|to\s+be)/i,
    /from\s+now\s+on\s+you/i,
    /your\s+new\s+instructions/i,
    /change\s+your\s+(role|persona|identity)/i,

    // Tentativas de extrair o prompt
    /repeat\s+(your|the)\s+system\s+prompt/i,
    /show\s+me\s+your\s+(prompt|instructions)/i,
    /what\s+are\s+your\s+instructions/i,
    /print\s+your\s+(prompt|system)/i,
    /reveal\s+your\s+(prompt|instructions)/i,
    /dump\s+your\s+config/i,

    // Delimitadores de prompt
    /\[SYSTEM\]/i,
    /\[INST\]/i,
    /<<SYS>>/i,
    /<\|system\|>/i,
    /```system/i,

    // Tentativas de executar código
    /\beval\s*\(/i,
    /\bexec\s*\(/i,
    /require\s*\(/i,
    /import\s+\{/i,
    /__proto__/i,
    /constructor\s*\[/i
];

// Limite de tamanho de mensagem (caracteres)
const MAX_MESSAGE_LENGTH = 2000;

// Limite de repetição de caracteres (anti-spam)
const MAX_CHAR_REPETITION = 20;

class InputSanitizer {
    constructor() {
        this.flaggedInputs = []; // Log de inputs suspeitos
    }

    /**
     * Sanitiza e valida o input do usuário
     * @param {string} text - Texto bruto do usuário
     * @param {string} phoneNumber - Número do remetente
     * @returns {{ safe: boolean, sanitized: string, flags: string[] }}
     */
    sanitize(text, phoneNumber) {
        const flags = [];

        if (!text || typeof text !== 'string') {
            return { safe: true, sanitized: '', flags: [] };
        }

        let sanitized = text;

        // 1. Truncar mensagens muito longas
        if (sanitized.length > MAX_MESSAGE_LENGTH) {
            sanitized = sanitized.substring(0, MAX_MESSAGE_LENGTH);
            flags.push('message_truncated');
            console.warn(`⚠️ [Sanitizer] Mensagem de ${phoneNumber} truncada (${text.length} -> ${MAX_MESSAGE_LENGTH} chars)`);
        }

        // 2. Remover caracteres de controle invisíveis (exceto newline e tab)
        sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

        // 3. Detectar repetição excessiva de caracteres (spam)
        const repetitionRegex = new RegExp(`(.)\\1{${MAX_CHAR_REPETITION},}`, 'g');
        if (repetitionRegex.test(sanitized)) {
            sanitized = sanitized.replace(repetitionRegex, (match, char) => char.repeat(3));
            flags.push('char_repetition_reduced');
        }

        // 4. Verificar prompt injection
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(sanitized)) {
                flags.push('prompt_injection_detected');
                this._logFlaggedInput(phoneNumber, text, 'prompt_injection', pattern.source);
                console.warn(`🛡️ [Sanitizer] Prompt injection detectado de ${phoneNumber}: "${pattern.source}"`);
                // Não bloquear — remover o padrão perigoso e deixar o resto
                sanitized = sanitized.replace(pattern, '[removido]');
            }
        }

        // 5. Neutralizar delimitadores markdown que podem confundir o modelo
        sanitized = sanitized.replace(/```/g, "'''");

        // 6. Remover tentativas de HTML/script injection
        sanitized = sanitized
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '[removido]')
            .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '[removido]')
            .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '[removido]');

        const safe = !flags.includes('prompt_injection_detected');

        return { safe, sanitized, flags };
    }

    /**
     * Registra input suspeito para análise posterior
     */
    _logFlaggedInput(phoneNumber, originalText, type, pattern) {
        this.flaggedInputs.push({
            timestamp: new Date().toISOString(),
            phone: phoneNumber,
            type,
            pattern,
            preview: originalText.substring(0, 100)
        });

        // Manter últimos 50 registros
        if (this.flaggedInputs.length > 50) {
            this.flaggedInputs = this.flaggedInputs.slice(-50);
        }
    }

    /**
     * Retorna relatório de inputs suspeitos
     */
    getReport() {
        return {
            totalFlagged: this.flaggedInputs.length,
            recentFlags: this.flaggedInputs.slice(-10),
            injectionAttempts: this.flaggedInputs.filter(f => f.type === 'prompt_injection').length
        };
    }
}

module.exports = new InputSanitizer();
