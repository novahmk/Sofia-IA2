/**
 * Function Calling System
 * Define funções que Sofia pode chamar para buscar dados reais
 * Persistido em SQLite via database.js (com fallback para JSON)
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { getAvailableSlots, scheduleConsultation } = require('./calendar');

const db = require('./database');
const APPOINTMENTS_FILE = path.join(__dirname, 'appointments.json');
const CLIENTS_DATA_FILE = path.join(__dirname, 'clients_data.json');

class FunctionCalling {
    constructor() {
        this.appointments = this.loadAppointments();
        this.clientsData = this.loadClientsData();
    }

    /**
     * Carrega agendamentos (SQLite primeiro, fallback JSON)
     */
    loadAppointments() {
        if (db) {
            try {
                return db.getAppointments();
            } catch (error) {
                console.warn(`⚠️ Erro ao carregar agendamentos do SQLite: ${error.message}`);
            }
        }
        try {
            if (fs.existsSync(APPOINTMENTS_FILE)) {
                return JSON.parse(fs.readFileSync(APPOINTMENTS_FILE, 'utf-8'));
            }
        } catch (error) {
            console.warn(`⚠️ Erro ao carregar agendamentos: ${error.message}`);
        }
        return [];
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
     * Salva agendamentos (SQLite + fallback JSON)
     */
    async saveAppointments() {
        // SQLite já salva individualmente via insertAppointment
        // Fallback JSON
        if (!db) {
            try {
                await fsPromises.writeFile(APPOINTMENTS_FILE, JSON.stringify(this.appointments, null, 2));
            } catch (error) {
                console.error(`❌ Erro ao salvar agendamentos: ${error.message}`);
            }
        }
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
                    name: 'check_available_appointments',
                    description: 'Verifica horários disponíveis para consulta em um dia específico',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: {
                                type: 'string',
                                description: 'Data no formato DD/MM/YYYY (ex: 15/03/2026)'
                            },
                            preferred_time: {
                                type: 'string',
                                description: 'Horário preferido (ex: 14:00, 10:30). Opcional.'
                            }
                        },
                        required: ['date']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'book_appointment',
                    description: 'Agenda uma consulta para o cliente',
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
                            date: {
                                type: 'string',
                                description: 'Data da consulta (DD/MM/YYYY)'
                            },
                            time: {
                                type: 'string',
                                description: 'Horário da consulta (HH:MM)'
                            }
                        },
                        required: ['phone', 'name', 'date', 'time']
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
            case 'check_available_appointments':
                return this.checkAvailableAppointments(args.date, args.preferred_time);

            case 'book_appointment':
                return this.bookAppointment(args.phone, args.name, args.date, args.time);

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

    /**
     * Verifica horários disponíveis (integrado com Google Calendar quando configurado)
     */
    async checkAvailableAppointments(date, preferredTime = null) {
        const allSlots = [
            '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
            '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'
        ];

        const bookedSlots = [];

        // Tentar buscar do Google Calendar se configurado
        const calendarId = process.env.GOOGLE_CALENDAR_ID;
        const hasCalendar = calendarId && !calendarId.includes('seu-email');
        
        if (hasCalendar) {
            try {
                // Converter data DD/MM/YYYY para YYYY-MM-DD
                const [day, month, year] = date.split('/');
                const isoDate = `${year}-${month}-${day}`;
                
                const calendarEvents = await getAvailableSlots(isoDate);
                if (calendarEvents) {
                    calendarEvents.forEach(event => {
                        const startHour = new Date(event.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
                        bookedSlots.push(startHour);
                    });
                    console.log(`📅 Google Calendar: ${calendarEvents.length} eventos encontrados em ${date}`);
                }
            } catch (error) {
                console.warn(`⚠️ Falha ao consultar Google Calendar: ${error.message}. Usando dados locais.`);
            }
        }

        // Complementar com agendamentos locais
        const dayAppointments = this.appointments.filter(apt => apt.date === date);
        dayAppointments.forEach(apt => {
            if (!bookedSlots.includes(apt.time)) {
                bookedSlots.push(apt.time);
            }
        });

        const available = allSlots.filter(slot => !bookedSlots.includes(slot));

        console.log(`✅ Horários disponíveis em ${date}: ${available.length} slots`);

        return {
            date,
            total_available: available.length,
            available_times: available,
            booked_times: bookedSlots,
            recommended: preferredTime && available.includes(preferredTime) ? preferredTime : available[0]
        };
    }

    /**
     * Agenda uma consulta (com sync para Google Calendar quando configurado)
     */
    async bookAppointment(phone, name, date, time) {
        // Verificar se já existe agendamento no mesmo horário
        const exists = this.appointments.find(apt => apt.date === date && apt.time === time);
        if (exists) {
            return { error: `Horário ${time} em ${date} já está ocupado` };
        }

        const appointment = {
            id: `apt_${Date.now()}`,
            phone,
            name,
            date,
            time,
            created_at: new Date().toISOString(),
            status: 'confirmed',
            type: 'consultation'
        };

        this.appointments.push(appointment);
        // Salvar no SQLite
        if (db) {
            db.insertAppointment(appointment);
        }
        await this.saveAppointments();

        // Tentar sincronizar com Google Calendar
        const calendarId = process.env.GOOGLE_CALENDAR_ID;
        const hasCalendar = calendarId && !calendarId.includes('seu-email');
        
        if (hasCalendar) {
            try {
                const [day, month, year] = date.split('/');
                const startTime = `${year}-${month}-${day}T${time}:00`;
                const [h, m] = time.split(':').map(Number);
                const endHour = String(h + 1).padStart(2, '0');
                const endTime = `${year}-${month}-${day}T${endHour}:${String(m).padStart(2, '0')}:00`;
                
                await scheduleConsultation(name, startTime, endTime);
                console.log(`📅 Agendamento sincronizado com Google Calendar`);
            } catch (error) {
                console.warn(`⚠️ Falha ao sincronizar com Google Calendar: ${error.message}`);
            }
        }

        console.log(`✅ Agendamento confirmado: ${name} em ${date} às ${time}`);

        return {
            success: true,
            appointment_id: appointment.id,
            message: `Consulta agendada com sucesso para ${date} às ${time}h`,
            confirmation: `Seu agendamento foi confirmado! Consultoria gratuita em ${date} às ${time}h. Você receberá uma confirmação por WhatsApp.`
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
     * Retorna informações de preços
     */
    getPricingInfo(service = null) {
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
            surgery: {
                base_price: 12648.00,
                discount_price: 10000.00,
                installments: 24,
                installment_value: 527.00,
                payment_options: [
                    'Cartão de crédito (até 24x sem juros)',
                    'Pix/Dinheiro (desconto de R$ 2.648,00)'
                ],
                includes: [
                    'Procedimento transplante FUE ou DHI',
                    'Anestesia local',
                    'Medicações pós-operatório',
                    'Acompanhamento 12 meses',
                    'Consultas mensais',
                    'Suporte 24/7'
                ]
            }
        };

        if (service && pricing[service]) {
            return pricing[service];
        }

        return pricing;
    }
}

module.exports = new FunctionCalling();
