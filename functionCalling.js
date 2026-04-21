/**
 * Function Calling System
 * Define funções que Sofia pode chamar para buscar dados reais
 * Integrado com Feegow API para agendamentos
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const feegow = require('./feegow');
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
                    name: 'check_available_appointments',
                    description: 'Verifica horários disponíveis para um procedimento nos próximos dias via Feegow. Procedimentos: MESOTERAPIA (id=1), PRP (id=2), LIMPEZA DE PELE (id=3), BOTOX (id=8), TRANSPLANTE CAPILAR (id=9)',
                    parameters: {
                        type: 'object',
                        properties: {
                            procedure_name: {
                                type: 'string',
                                description: 'Nome do procedimento (ex: mesoterapia, prp, botox, transplante, limpeza de pele). Se não souber, use "mesoterapia"'
                            },
                            date: {
                                type: 'string',
                                description: 'Data específica no formato DD/MM/YYYY. Opcional — se não informado, busca os próximos 7 dias.'
                            },
                            preferred_time: {
                                type: 'string',
                                description: 'Horário preferido (ex: 14:00, 10:30). Opcional.'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'book_appointment',
                    description: 'Agenda uma consulta/procedimento no Feegow. REQUER: nome, telefone, data e horário confirmados pelo cliente.',
                    parameters: {
                        type: 'object',
                        properties: {
                            phone: {
                                type: 'string',
                                description: 'Número de telefone do cliente (ex: 5511999999999)'
                            },
                            name: {
                                type: 'string',
                                description: 'Nome completo do cliente'
                            },
                            date: {
                                type: 'string',
                                description: 'Data da consulta (DD/MM/YYYY)'
                            },
                            time: {
                                type: 'string',
                                description: 'Horário da consulta (HH:MM)'
                            },
                            procedure_name: {
                                type: 'string',
                                description: 'Nome do procedimento (mesoterapia, prp, botox, etc). Padrão: mesoterapia'
                            }
                        },
                        required: ['phone', 'name', 'date', 'time']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'search_appointments',
                    description: 'Busca agendamentos existentes de um paciente no Feegow',
                    parameters: {
                        type: 'object',
                        properties: {
                            paciente_id: {
                                type: 'number',
                                description: 'ID do paciente no Feegow'
                            },
                            data_start: {
                                type: 'string',
                                description: 'Data início (DD/MM/YYYY)'
                            },
                            data_end: {
                                type: 'string',
                                description: 'Data fim (DD/MM/YYYY)'
                            }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'cancel_appointment',
                    description: 'Cancela um agendamento existente no Feegow',
                    parameters: {
                        type: 'object',
                        properties: {
                            agendamento_id: {
                                type: 'number',
                                description: 'ID do agendamento a cancelar'
                            },
                            motivo: {
                                type: 'string',
                                description: 'Motivo do cancelamento'
                            }
                        },
                        required: ['agendamento_id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'reschedule_appointment',
                    description: 'Remarca um agendamento para nova data/horário no Feegow',
                    parameters: {
                        type: 'object',
                        properties: {
                            agendamento_id: {
                                type: 'number',
                                description: 'ID do agendamento a remarcar'
                            },
                            new_date: {
                                type: 'string',
                                description: 'Nova data (DD/MM/YYYY)'
                            },
                            new_time: {
                                type: 'string',
                                description: 'Novo horário (HH:MM)'
                            },
                            motivo: {
                                type: 'string',
                                description: 'Motivo da remarcação'
                            }
                        },
                        required: ['agendamento_id', 'new_date', 'new_time']
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

            case 'check_available_appointments':
                return this.checkAvailableAppointments(args.procedure_name, args.date, args.preferred_time);

            case 'book_appointment':
                return this.bookAppointment(args.phone, args.name, args.date, args.time, args.procedure_name);

            case 'search_appointments':
                return this.searchAppointments(args.paciente_id, args.data_start, args.data_end);

            case 'cancel_appointment':
                return this.cancelAppointment(args.agendamento_id, args.motivo);

            case 'reschedule_appointment':
                return this.rescheduleAppointment(args.agendamento_id, args.new_date, args.new_time, args.motivo);

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

    // Mapa de nomes de procedimentos para IDs do Feegow
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
     * Verifica horários disponíveis via Feegow API
     */
    async checkAvailableAppointments(procedureName = 'mesoterapia', date = null, preferredTime = null) {
        try {
            const procedureId = this._resolveProcedureId(procedureName);
            let dataStart, dataEnd;

            if (date) {
                // Data específica: converter DD/MM/YYYY para DD-MM-YYYY
                dataStart = date.replace(/\//g, '-');
                dataEnd = dataStart;
            } else {
                // Próximos 7 dias
                dataStart = feegow.today();
                dataEnd = feegow.daysFromNow(7);
            }

            console.log(`📅 Feegow: buscando slots para procedimento ${procedureId} de ${dataStart} a ${dataEnd}`);
            const slots = await feegow.getAvailableSlots(procedureId, dataStart, dataEnd);

            if (!slots || slots.length === 0) {
                return {
                    date: date || `${dataStart} a ${dataEnd}`,
                    total_available: 0,
                    available_times: [],
                    message: 'Não encontrei horários disponíveis nesse período. Quer que eu busque em outra data?'
                };
            }

            // Se o cliente pediu horário específico, destacar
            let recommended = null;
            if (preferredTime) {
                for (const slot of slots) {
                    if (slot.horarios.includes(preferredTime)) {
                        recommended = { data: slot.data, horario: preferredTime, profissional_id: slot.profissional_id, local_id: slot.local_id };
                        break;
                    }
                }
            }

            // Formatar para a IA mostrar de forma bonita
            const formatted = feegow.formatAvailableSlots(slots);

            console.log(`✅ Feegow: ${slots.length} dia(s) com disponibilidade`);

            return {
                date: date || `próximos 7 dias`,
                total_available: slots.reduce((sum, s) => sum + s.horarios.length, 0),
                days_available: slots.length,
                slots: slots.map(s => ({ data: s.data, horarios: s.horarios, profissional_id: s.profissional_id, local_id: s.local_id })),
                formatted,
                recommended,
                procedure_id: procedureId
            };
        } catch (error) {
            console.error(`❌ Erro ao buscar horários no Feegow: ${error.message}`);
            return { error: `Não consegui consultar os horários: ${error.message}` };
        }
    }

    /**
     * Agenda uma consulta via Feegow API
     */
    async bookAppointment(phone, name, date, time, procedureName = 'mesoterapia') {
        try {
            const procedureId = this._resolveProcedureId(procedureName);
            // Converter DD/MM/YYYY para DD-MM-YYYY
            const feegowDate = date.replace(/\//g, '-');
            const feegowTime = time.length === 5 ? `${time}:00` : time; // HH:MM -> HH:MM:SS

            // Buscar slot disponível para pegar profissional_id e local_id
            const slots = await feegow.getAvailableSlots(procedureId, feegowDate, feegowDate);
            if (!slots || slots.length === 0) {
                return { error: `Não há horários disponíveis em ${date}. Quer tentar outra data?` };
            }

            // Encontrar o slot com o horário pedido
            let profissionalId = null;
            let localId = 0;
            const timeShort = time.substring(0, 5);
            for (const slot of slots) {
                if (slot.horarios.includes(timeShort)) {
                    profissionalId = slot.profissional_id;
                    localId = slot.local_id;
                    break;
                }
            }

            if (!profissionalId) {
                return { error: `Horário ${time} não está disponível em ${date}. Horários livres: ${slots[0]?.horarios?.slice(0, 5).join(', ')}` };
            }

            // Pegar especialidade do procedimento
            const specialties = await feegow.listSpecialties();
            const especialidadeId = specialties.length > 0 ? specialties[0].id : 125;

            console.log(`📅 Feegow: criando agendamento - prof=${profissionalId}, proc=${procedureId}, ${feegowDate} ${feegowTime}`);

            const result = await feegow.createAppointment({
                pacienteId: 0, // Feegow pode criar paciente inline
                profissionalId,
                especialidadeId,
                procedimentoId: procedureId,
                data: feegowDate,
                horario: feegowTime,
                localId,
                valor: 0,
                notas: `Agendado via Sofia WhatsApp - ${name}`,
                celular: phone
            });

            console.log(`✅ Agendamento Feegow criado: ID ${result.agendamento_id}`);

            // Salvar referência local no SQLite
            if (db) {
                db.insertAppointment({
                    id: `feegow_${result.agendamento_id}`,
                    phone,
                    name,
                    date,
                    time,
                    created_at: new Date().toISOString(),
                    status: 'confirmed',
                    type: procedureName || 'mesoterapia',
                    feegow_id: result.agendamento_id
                });
            }

            return {
                success: true,
                agendamento_id: result.agendamento_id,
                message: `Agendamento confirmado para ${date} às ${time}h`,
                confirmation: `Pronto! Agendei ${procedureName || 'sua consulta'} para ${date} às ${time}h na Quality Hair. Até lá! 💇`
            };
        } catch (error) {
            console.error(`❌ Erro ao agendar no Feegow: ${error.message}`);
            return { error: `Não consegui finalizar o agendamento: ${error.message}. Quer que eu tente novamente?` };
        }
    }

    /**
     * Busca agendamentos existentes via Feegow
     */
    async searchAppointments(pacienteId, dataStart, dataEnd) {
        try {
            const filters = {};
            if (pacienteId) filters.pacienteId = pacienteId;
            if (dataStart) filters.dataStart = dataStart.replace(/\//g, '-');
            if (dataEnd) filters.dataEnd = dataEnd.replace(/\//g, '-');

            if (!filters.dataStart) {
                filters.dataStart = feegow.today();
                filters.dataEnd = feegow.daysFromNow(30);
            }

            const appointments = await feegow.searchAppointments(filters);
            return {
                total: appointments.length,
                agendamentos: appointments.map(a => ({
                    id: a.agendamento_id,
                    data: a.data,
                    horario: a.horario,
                    status_id: a.status_id,
                    procedimento_id: a.procedimento_id,
                    notas: a.notas
                }))
            };
        } catch (error) {
            return { error: `Erro ao buscar agendamentos: ${error.message}` };
        }
    }

    /**
     * Cancela agendamento via Feegow
     */
    async cancelAppointment(agendamentoId, motivo = '') {
        try {
            // motivo_id=1 = Solicitado pelo paciente
            const result = await feegow.cancelAppointment(agendamentoId, 1, motivo || 'Cancelado via WhatsApp');
            console.log(`✅ Agendamento ${agendamentoId} cancelado no Feegow`);
            return { success: true, message: `Agendamento #${agendamentoId} cancelado com sucesso.` };
        } catch (error) {
            return { error: `Erro ao cancelar: ${error.message}` };
        }
    }

    /**
     * Remarca agendamento via Feegow
     */
    async rescheduleAppointment(agendamentoId, newDate, newTime, motivo = '') {
        try {
            const feegowDate = newDate.replace(/\//g, '-');
            const feegowTime = newTime.length === 5 ? `${newTime}:00` : newTime;
            const result = await feegow.rescheduleAppointment(
                agendamentoId,
                feegowDate,
                feegowTime,
                1, // motivo_id=1 = Solicitado pelo paciente
                motivo || 'Remarcado via WhatsApp'
            );
            console.log(`✅ Agendamento ${agendamentoId} remarcado para ${newDate} ${newTime}`);
            return { success: true, message: `Agendamento remarcado para ${newDate} às ${newTime}h.` };
        } catch (error) {
            return { error: `Erro ao remarcar: ${error.message}` };
        }
    }

    /**
     * Lista procedimentos disponíveis via Feegow
     */
    async listProcedures() {
        try {
            const procedures = await feegow.listProcedures();
            return {
                total: procedures.length,
                procedimentos: procedures.map(p => ({
                    nome: p.nome,
                    valor: `R$ ${p.valor.toFixed(2)}`,
                    duracao: `${p.tempo} minutos`,
                    id: p.id
                }))
            };
        } catch (error) {
            return { error: `Erro ao listar procedimentos: ${error.message}` };
        }
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
     * Retorna informações de preços (dados reais do Feegow + info da clínica)
     */
    async getPricingInfo(service = null) {
        // Tentar carregar preços reais do Feegow
        let feegowPrices = {};
        try {
            const procedures = await feegow.listProcedures();
            for (const p of procedures) {
                feegowPrices[p.nome.toLowerCase()] = {
                    nome: p.nome,
                    valor: p.valor,
                    duracao: `${p.tempo} minutos`
                };
            }
        } catch (error) {
            console.warn(`⚠️ Falha ao buscar preços Feegow: ${error.message}`);
        }

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
            mesoterapia: feegowPrices['mesoterapia'] || { valor: 350, duracao: '30 minutos' },
            prp: feegowPrices['prp'] || { valor: 300, duracao: '30 minutos' },
            botox: feegowPrices['botox'] || { valor: 860, duracao: '60 minutos' },
            limpeza_de_pele: feegowPrices['limpeza de pele'] || { valor: 320, duracao: '60 minutos' },
            transplante: feegowPrices['transplante capilar'] || { valor: 10000, duracao: '480 minutos' }
        };

        if (service && pricing[service]) {
            return pricing[service];
        }

        return pricing;
    }
}

module.exports = new FunctionCalling();
