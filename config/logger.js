/**
 * Logger centralizado para Sofia IA
 * @module config/logger
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const COLORS = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m'   // Reset
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

/**
 * Formata uma mensagem de log com timestamp e nível
 * @private
 */
function formatMessage(level, message, data) {
  const timestamp = new Date().toISOString();
  const levelUpper = level.toUpperCase().padEnd(5);
  const color = COLORS[level];
  const reset = COLORS.reset;

  let msg = `${color}[${timestamp}] [${levelUpper}]${reset} ${message}`;

  if (data) {
    if (typeof data === 'object') {
      msg += ` ${JSON.stringify(data)}`;
    } else {
      msg += ` ${data}`;
    }
  }

  return msg;
}

const logger = {
  /**
   * Log de debug (verbose)
   */
  debug: (message, data) => {
    if (LOG_LEVELS.debug >= currentLevel) {
      console.log(formatMessage('debug', message, data));
    }
  },

  /**
   * Log de informação
   */
  info: (message, data) => {
    if (LOG_LEVELS.info >= currentLevel) {
      console.log(formatMessage('info', message, data));
    }
  },

  /**
   * Log de aviso
   */
  warn: (message, data) => {
    if (LOG_LEVELS.warn >= currentLevel) {
      console.warn(formatMessage('warn', message, data));
    }
  },

  /**
   * Log de erro
   */
  error: (message, error) => {
    if (LOG_LEVELS.error >= currentLevel) {
      let errorData = error;
      if (error instanceof Error) {
        errorData = {
          message: error.message,
          stack: error.stack.split('\n').slice(0, 3).join(' | ')
        };
      }
      console.error(formatMessage('error', message, errorData));
    }
  },

  /**
   * Log com timestamp formatado (para operações críticas)
   */
  critical: (message, data) => {
    const timestamp = new Date().toISOString();
    console.error(`\x1b[31m🚨 [${timestamp}] CRÍTICO: ${message}\x1b[0m`, data || '');
  }
};

module.exports = logger;
