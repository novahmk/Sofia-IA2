/**
 * Function Calling System
 * Define funções que Sofia pode chamar para buscar dados reais
 * Integrado com Google Calendar para agendamentos
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const calendarService = require('./calendar');

const db = require('./database');
const CLIENTS_DATA_FILE = path.join(__dirname, 'clients_data.json');

class FunctionCalling {
    constructor() {
        this.clientsData = this.loadClientsData();
    }

    /**
     * Carrega dados de clientes (SQLite primeiro, fallback JSON)
     */
    loadClientsData() {
        if (db) {
            try {
                return db.getAll('clients_data');
            } catch (error) {
                console.warn(`⚠️ Erro ao carregar dados de clientes do SQLite: ${error.message}`);
            }
        }
        try {
            if (fs.existsSync(CLIENTS_DATA_FILE)) {
                return JSON.parse(fs.readFileSync(CLIENTS_DATA_FILE, 'utf-8'));
            }
        } catch (error) {
            console.warn(`⚠️ Erro ao carregar dados de clientes: ${error.message}`);
        }
        return {};
    }

    /**
     * Salva dados de clientes (SQLite + fallback JSON)
     */
    async saveClientsData() {
        if (db) {
            try {
                for (const [phone, data] of Object.entries(this.clientsData)) {
                    db.set('clients_data', phone, data);
                }
                return;
            } catch (error) {
                console.error(`❌ Erro ao salvar clientes no SQLite: ${error.message}`);
            }
        }
        try {
            await fsPromises.writeFile(CLIENTS_DATA_FILE, JSON.stringify(this.clientsData, null, 2));
        } catch (error) {
            console.error(`❌ Erro ao salvar dados de clientes: ${error.message}`);
        }
    }

    /**
     * Define os schemas de funções que Sofia pode usar
     */
    getToolSchemas() {
        return [
            {
                type: 'function',
                function: {
                    name: 'list_calendar_events',
                    description: 'Lista eventos do Google Calendar em um período específico.',
                    parameters: {
                        type: 'object',
                        properties: {
                            start_date: {
                                type: 'string',
                                description: 'Data inicial do período. Aceita DD/MM, DD/MM/YYYY ou YYYY-MM-DD.'
                            },
                            end_date: {
                                type: 'string',
                                description: 'Data final do período. Aceita DD/MM, DD/MM/YYYY ou YYYY-MM-DD.'
                            }
                        },
                        required: ['start_date', 'end_date']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'check_calendar_availability',
                    description: 'Verifica se um horário está livre no Google Calendar. Use apenas quando data e horário estiverem claros.',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: {
                                type: 'string',
                                description: 'Data do horário a verificar. Aceita DD/MM, DD/MM/YYYY ou YYYY-MM-DD.'
                            },
                            time: {
                                type: 'string',
                                description: 'Horário inicial no formato HH:MM.'
                            },
                            duration_minutes: {
                                type: 'integer',
                                description: 'Duração do intervalo em minutos. Padrão: 60.'
                            },
                            end_time: {
                                type: 'string',
                                description: 'Horário final opcional no formato HH:MM. Se enviado, substitui a duração.'
                            }
                        },
                        required: ['date', 'time']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'create_calendar_event',
                    description: 'Cria um novo evento no Google Calendar. Só use depois que o usuário confirmar explicitamente os detalhes.',
                    parameters: {
                        type: 'object',
                        properties: {
                            title: {
                                type: 'string',
                                description: 'Título ou assunto do evento.'
                            },
                            description: {
                                type: 'string',
                                description: 'Descrição do evento.'
                            },
                            date: {
                                type: 'string',
                                description: 'Data do evento. Aceita DD/MM, DD/MM/YYYY ou YYYY-MM-DD.'
                            },
                            time: {
                                type: 'string',
                                description: 'Horário inicial do evento no formato HH:MM.'
                            },
                            duration_minutes: {
                                type: 'integer',
                                description: 'Duração em minutos. Use quando o usuário informar a duração.'
                            },
                            end_time: {
                                type: 'string',
                                description: 'Horário final opcional no formato HH:MM.'
                            },
                            confirmed: {
                                type: 'boolean',
                                description: 'Só deve ser true quando o usuário confirmou explicitamente os detalhes finais.'
                            }
                        },
                        required: ['title', 'date', 'time', 'confirmed']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'update_calendar_event',
                    description: 'Edita um evento existente no Google Calendar.',
                    parameters: {
                        type: 'object',
                        properties: {
                            event_id: {
                                type: 'string',
                                description: 'ID do evento no Google Calendar.'
                            },
                            title: {
                                type: 'string',
                                description: 'Novo título do evento.'
                            },
                            description: {
                                type: 'string',
                                description: 'Nova descrição do evento.'
                            },
                            date: {
                                type: 'string',
                                description: 'Nova data do evento. Aceita DD/MM, DD/MM/YYYY ou YYYY-MM-DD.'
                            },
                            time: {
                                type: 'string',
                                description: 'Novo horário inicial no formato HH:MM.'
                            },
                            duration_minutes: {
                                type: 'integer',
                                description: 'Nova duração em minutos.'
                            },
                            end_time: {
                                type: 'string',
                                description: 'Novo horário final opcional no formato HH:MM.'
                            }
                        },
                        required: ['event_id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'delete_calendar_event',
                    description: 'Deleta um evento do Google Calendar. Só use depois que o usuário confirmar explicitamente a exclusão.',
                    parameters: {
                        type: 'object',
                        properties: {
                            event_id: {
                                type: 'string',
                                description: 'ID do evento no Google Calendar.'
                            },
                            confirmed: {
                                type: 'boolean',
                                description: 'Só deve ser true quando o usuário confirmou explicitamente a exclusão.'
                            }
                        },
                        required: ['event_id', 'confirmed']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'list_procedures',
                    description: 'Lista todos os procedimentos disponíveis na clínica com preços e duração',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'get_client_info',
                    description: 'Recupera informações salvas sobre um cliente',
                    parameters: {
                        type: 'object',
                        properties: {
                            phone: {
                                type: 'string',
                                description: 'Número de telefone do cliente'
                            }
                        },
                        required: ['phone']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'save_client_info',
                    description: 'Salva informações sobre um cliente para futuros atendimentos',
                    parameters: {
                        type: 'object',
                        properties: {
                            phone: {
                                type: 'string',
                                description: 'Número de telefone do cliente'
                            },
                            name: {
                                type: 'string',
                                description: 'Nome do cliente'
                            },
                            location: {
                                type: 'string',
                                description: 'Localização/cidade do cliente'
                            },
                            baldness_degree: {
                                type: 'string',
                                description: 'Grau de calvície (Norwood I-VII)'
                            },
                            concerns: {
                                type: 'string',
                                description: 'Preocupações ou dúvidas principais do cliente'
                            },
                            contact_preference: {
                                type: 'string',
                                description: 'Preferência de contato (WhatsApp, telefone, etc)'
                            }
                        },
                        required: ['phone', 'name']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'get_pricing_info',
                    description: 'Retorna informações atualizadas sobre preços e pacotes',
                    parameters: {
                        type: 'object',
                        properties: {
                            service: {
                                type: 'string',
                                description: 'Tipo de serviço (consultation, surgery, etc)'
                            }
                        },
                        required: []
                    }
                }
            }
        ];
    }

    /**
     * Executa uma função chamada por Sofia
     */
    async executeFunction(functionName, args) {
        console.log(`🔧 Executando função: ${functionName}`, args);

        switch (functionName) {
            case 'list_calendar_events':
                return this.listCalendarEvents(args.start_date, args.end_date);

            case 'check_calendar_availability':
                return this.checkCalendarAvailability(args.date, args.time, args.duration_minutes, args.end_time);

            case 'create_calendar_event':
                return this.createCalendarEvent(args);

            case 'update_calendar_event':
                return this.updateCalendarEvent(args);

            case 'delete_calendar_event':
                return this.deleteCalendarEvent(args.event_id, args.confirmed);

            case 'list_procedures':
                return this.listProcedures();

            case 'get_client_info':
                return this.getClientInfo(args.phone);

            case 'save_client_info':
                return this.saveClientInfo(args);

            case 'get_pricing_info':
                return this.getPricingInfo(args.service);

            default:
                return { error: `Função não reconhecida: ${functionName}` };
        }
    }

    // Mapa legado de nomes de procedimentos
    _procedureMap = {
        'mesoterapia': 1,
        'meso': 1,
        'prp': 2,
        'limpeza de pele': 3,
        'limpeza': 3,
        'botox': 8,
        'transplante capilar': 9,
        'transplante': 9
    };

    /**
     * Resolve o ID do procedimento a partir do nome
     */
    _resolveProcedureId(name) {
        if (!name) return 1; // default: mesoterapia
        const lower = name.toLowerCase().trim();
        return this._procedureMap[lower] || 1;
    }

    async listCalendarEvents(startDate, endDate) {
        return calendarService.listEvents(startDate, endDate);
    }

    async checkCalendarAvailability(date, time, durationMinutes = 60, endTime = null) {
        return calendarService.checkAvailability(date, time, durationMinutes, endTime);
    }

    async createCalendarEvent({ title, description = '', date, time, duration_minutes: durationMinutes = 60, end_time: endTime = null, confirmed = false }) {
        if (!confirmed) {
            return { error: 'Criação não executada: o usuário ainda não confirmou os detalhes do evento.' };
        }

        const result = await calendarService.createEvent({
            title,
            description,
            date,
            time,
            durationMinutes,
            endTime,
        });

        if (result.error) {
            return result;
        }

        return {
            success: true,
            message: 'Evento criado com sucesso.',
            event: result.event,
        };
    }

    async updateCalendarEvent({ event_id: eventId, title, description, date, time, duration_minutes: durationMinutes, end_time: endTime = null }) {
        const result = await calendarService.updateEvent({
            eventId,
            title,
            description,
            date,
            time,
            durationMinutes,
            endTime,
        });

        if (result.error) {
            return result;
        }

        return {
            success: true,
            message: 'Evento atualizado com sucesso.',
            event: result.event,
        };
    }

    async deleteCalendarEvent(eventId, confirmed = false) {
        if (!confirmed) {
            return { error: 'Exclusão não executada: o usuário ainda não confirmou a remoção do evento.' };
        }

        const result = await calendarService.deleteEvent(eventId);

        if (result.error) {
            return result;
        }

        return {
            success: true,
            message: `Evento ${eventId} removido com sucesso.`,
            event_id: eventId,
        };
    }

    /**
     * Método legado mantido apenas por compatibilidade
     */
    async checkAvailableAppointments(procedureName = 'mesoterapia', date = null, preferredTime = null) {
        return {
            error: 'A integração legada de agendamento foi desativada. Use Google Calendar para consultar disponibilidade e criar agendamentos.'
        };
    }

    /**
     * Método legado mantido apenas por compatibilidade
     */
    async bookAppointment(phone, name, date, time, procedureName = 'mesoterapia') {
        return {
            error: 'A integração legada de agendamento foi desativada. Use create_calendar_event para confirmar agendamentos.'
        };
    }

    /**
    * Método legado mantido apenas por compatibilidade
     */
    async searchAppointments(pacienteId, dataStart, dataEnd) {
        return {
            error: 'A integração legada de agendamento foi desativada. Use list_calendar_events para consultar eventos.'
        };
    }

    /**
    * Método legado mantido apenas por compatibilidade
     */
    async cancelAppointment(agendamentoId, motivo = '') {
        return {
            error: 'A integração legada de agendamento foi desativada. Use delete_calendar_event para cancelamentos.'
        };
    }

    /**
    * Método legado mantido apenas por compatibilidade
     */
    async rescheduleAppointment(agendamentoId, newDate, newTime, motivo = '') {
        return {
            error: 'A integração legada de agendamento foi desativada. Use update_calendar_event para remarcar.'
        };
    }

    /**
    * Lista procedimentos estáticos disponíveis
     */
    async listProcedures() {
        return {
            total: 5,
            procedimentos: [
                { nome: 'Mesoterapia', valor: 'R$ 350,00', duracao: '30 minutos', id: 'mesoterapia' },
                { nome: 'PRP', valor: 'R$ 300,00', duracao: '30 minutos', id: 'prp' },
                { nome: 'Botox Capilar', valor: 'R$ 860,00', duracao: '60 minutos', id: 'botox' },
                { nome: 'Limpeza de Pele', valor: 'R$ 320,00', duracao: '60 minutos', id: 'limpeza_de_pele' },
                { nome: 'Transplante Capilar', valor: 'R$ 10000,00', duracao: '480 minutos', id: 'transplante' }
            ]
        };
    }

    /**
     * Recupera informações do cliente
     */
    getClientInfo(phone) {
        const info = this.clientsData[phone];

        if (!info) {
            return { found: false, message: 'Nenhuma informação anterior encontrada para este cliente' };
        }

        return {
            found: true,
            ...info,
            previous_interactions: info.interaction_count || 0,
            last_interaction: info.last_contacted
        };
    }

    /**
     * Salva informações do cliente
     */
    saveClientInfo(data) {
        const { phone, name, location, baldness_degree, concerns, contact_preference } = data;

        // Atualizar ou criar
        if (!this.clientsData[phone]) {
            this.clientsData[phone] = {
                phone,
                name,
                created_at: new Date().toISOString(),
                interaction_count: 0
            };
        }

        // Atualizar campos fornecidos
        const clientInfo = this.clientsData[phone];
        if (name) clientInfo.name = name;
        if (location) clientInfo.location = location;
        if (baldness_degree) clientInfo.baldness_degree = baldness_degree;
        if (concerns) clientInfo.concerns = concerns;
        if (contact_preference) clientInfo.contact_preference = contact_preference;

        clientInfo.interaction_count = (clientInfo.interaction_count || 0) + 1;
        clientInfo.last_contacted = new Date().toISOString();

        this.saveClientsData();

        console.log(`✅ Informações do cliente salvas: ${phone}`);

        return {
            success: true,
            message: `Perfil de ${name} atualizado com sucesso`,
            client: clientInfo
        };
    }

    /**
     * Retorna informações de preços estáticas da clínica
     */
    async getPricingInfo(service = null) {
        const pricing = {
            consultation: {
                original_price: 700.00,
                current_price: 0.00,
                status: 'GRÁTIS (Promoção)',
                includes: [
                    'Avaliação completa',
                    'Planejamento cirúrgico exclusivo',
                    'Exame de imagem (tricoscopia)',
                    'Diagnóstico de calvície (Norwood)'
                ]
            },
            mesoterapia: { valor: 350, duracao: '30 minutos' },
            prp: { valor: 300, duracao: '30 minutos' },
            botox: { valor: 860, duracao: '60 minutos' },
            limpeza_de_pele: { valor: 320, duracao: '60 minutos' },
            transplante: { valor: 10000, duracao: '480 minutos' }
        };

        if (service && pricing[service]) {
            return pricing[service];
        }

        return pricing;
    }
}

module.exports = new FunctionCalling();
