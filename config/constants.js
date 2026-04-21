/**
 * Constantes globais do projeto Sofia IA
 * @module config/constants
 */

module.exports = {
  // Timeouts
  TIMEOUT_DEFAULT: 30000,
  TIMEOUT_API_CALL: 10000,
  TIMEOUT_DATABASE: 5000,

  // Limites de rate limit
  RATE_LIMIT_WINDOW: 60 * 1000, // 1 minuto
  RATE_LIMIT_MAX_REQUESTS: 100,

  // Configurações de calendário
  CALENDAR_BUSINESS_START: '08:00',
  CALENDAR_BUSINESS_END: '18:00',
  DEFAULT_CONSULTATION_DURATION: 60, // minutos

  // Status de integração
  INTEGRATION_STATUS: {
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
    PENDING: 'pending'
  },

  // Tipos de agentes
  AGENT_TYPES: {
    COMMERCIAL: 'commercial',
    TECHNICAL: 'technical',
    ADMINISTRATIVE: 'administrative',
    SUPERVISOR: 'supervisor'
  },

  // Erros comuns
  ERRORS: {
    MISSING_ENV: (variable) => `Variável de ambiente obrigatória não configurada: ${variable}`,
    INVALID_CALENDAR_ID: 'ID de calendário inválido ou não acessível',
    RATE_LIMITED: 'Muitas requisições. Tente novamente em alguns momentos',
    AUTHENTICATION_FAILED: 'Falha na autenticação com Google',
    DATABASE_ERROR: 'Erro ao conectar com o banco de dados'
  }
};
