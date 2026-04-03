/**
 * Feegow API Client
 * Integração com o sistema de agendamento Feegow para Quality Hair
 * Base URL: https://api.feegow.com/v1/api/
 */

const https = require('https');

const BASE_URL = 'https://api.feegow.com/v1/api';

class FeegowClient {
    constructor() {
        this.token = process.env.FEEGOW_TOKEN;
        // Canal WhatsApp = 10 (conforme Feegow)
        this.canalId = 10;
        // Cache de dados estáticos (procedimentos, especialidades, etc.)
        this._cache = {};
        this._cacheExpiry = {};
        this._cacheTTL = 30 * 60 * 1000; // 30 minutos
    }

    /**
     * Faz requisição GET à API Feegow
     */
    _get(endpoint, params = {}) {
        const query = new URLSearchParams(params).toString();
        const url = `${BASE_URL}${endpoint}${query ? '?' + query : ''}`;

        return new Promise((resolve, reject) => {
            const req = https.get(url, {
                headers: { 'x-access-token': this.token }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.success) {
                            resolve(json);
                        } else {
                            reject(new Error(json.message || `Feegow API error: ${JSON.stringify(json)}`));
                        }
                    } catch (e) {
                        reject(new Error(`Feegow parse error: ${e.message}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('Feegow timeout')); });
        });
    }

    /**
     * Faz requisição POST à API Feegow
     */
    _post(endpoint, body = {}) {
        const url = new URL(`${BASE_URL}${endpoint}`);
        const postData = JSON.stringify(body);

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'x-access-token': this.token,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.success) {
                            resolve(json);
                        } else {
                            reject(new Error(json.message || `Feegow API error: ${JSON.stringify(json)}`));
                        }
                    } catch (e) {
                        reject(new Error(`Feegow parse error: ${e.message}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('Feegow timeout')); });
            req.write(postData);
            req.end();
        });
    }

    /**
     * Cache helper
     */
    async _cached(key, fetcher) {
        if (this._cache[key] && this._cacheExpiry[key] > Date.now()) {
            return this._cache[key];
        }
        const result = await fetcher();
        this._cache[key] = result;
        this._cacheExpiry[key] = Date.now() + this._cacheTTL;
        return result;
    }

    // ===== PROCEDIMENTOS =====

    /**
     * Lista procedimentos disponíveis (cached)
     */
    async listProcedures() {
        return this._cached('procedures', async () => {
            const res = await this._get('/procedures/list');
            return res.content.map(p => ({
                id: p.procedimento_id,
                nome: p.nome,
                valor: p.valor / 100, // centavos -> reais
                tempo: parseInt(p.tempo) || 30,
                agendamento_online: p.permite_agendamento_online
            }));
        });
    }

    /**
     * Busca procedimento por nome (parcial, case-insensitive)
     */
    async findProcedure(name) {
        const procedures = await this.listProcedures();
        const lower = name.toLowerCase();
        return procedures.find(p => p.nome.toLowerCase().includes(lower));
    }

    // ===== ESPECIALIDADES =====

    async listSpecialties() {
        return this._cached('specialties', async () => {
            const res = await this._get('/specialties/list');
            return res.content.map(s => ({
                id: s.especialidade_id,
                nome: s.nome
            }));
        });
    }

    // ===== HORÁRIOS DISPONÍVEIS =====

    /**
     * Busca horários disponíveis para um procedimento
     * @param {number} procedimentoId - ID do procedimento
     * @param {string} dataStart - Data início DD-MM-YYYY
     * @param {string} dataEnd - Data fim DD-MM-YYYY
     * @param {number} profissionalId - (opcional) ID do profissional
     * @returns {Array} Lista de { data, horarios, profissional_id, local_id }
     */
    async getAvailableSlots(procedimentoId, dataStart, dataEnd, profissionalId = null) {
        const params = {
            tipo: 'P',
            procedimento_id: procedimentoId,
            unidade_id: 0,
            data_start: dataStart,
            data_end: dataEnd
        };
        if (profissionalId) {
            params.profissional_id = profissionalId;
        }

        const res = await this._get('/appoints/available-schedule', params);
        const slots = [];

        // Estrutura: { profissional_id: { "1": { local_id: { "1": { "2026-03-19": ["09:00:00",...] } } } } }
        const profissionais = res.content?.profissional_id || {};

        for (const [profId, profData] of Object.entries(profissionais)) {
            const localIds = profData.local_id || {};
            for (const [locId, dates] of Object.entries(localIds)) {
                for (const [date, hours] of Object.entries(dates)) {
                    if (!Array.isArray(hours)) continue;
                    slots.push({
                        data: date, // YYYY-MM-DD
                        horarios: hours.map(h => h.substring(0, 5)), // "09:00:00" -> "09:00"
                        profissional_id: parseInt(profId),
                        local_id: parseInt(locId)
                    });
                }
            }
        }

        // Agrupar por data (mesclar horários de diferentes profissionais/locais)
        const grouped = {};
        for (const slot of slots) {
            if (!grouped[slot.data]) {
                grouped[slot.data] = { data: slot.data, horarios: new Set(), profissionais: [] };
            }
            slot.horarios.forEach(h => grouped[slot.data].horarios.add(h));
            grouped[slot.data].profissionais.push({ profissional_id: slot.profissional_id, local_id: slot.local_id });
        }

        const merged = Object.values(grouped).map(g => ({
            data: g.data,
            horarios: [...g.horarios].sort(),
            profissional_id: g.profissionais[0].profissional_id,
            local_id: g.profissionais[0].local_id,
            profissionais: g.profissionais
        }));

        // Ordenar por data
        merged.sort((a, b) => a.data.localeCompare(b.data));
        return merged;
    }

    /**
     * Formata horários disponíveis para exibição amigável
     */
    formatAvailableSlots(slots) {
        if (!slots || slots.length === 0) {
            return 'Não encontrei horários disponíveis nesse período.';
        }

        const lines = [];
        for (const slot of slots) {
            // Converter YYYY-MM-DD para DD/MM
            const [y, m, d] = slot.data.split('-');
            const dateStr = `${d}/${m}`;
            const dayName = this._getDayName(slot.data);
            const times = slot.horarios.join(', ');
            lines.push(`📅 ${dayName} ${dateStr}: ${times}`);
        }
        return lines.join('\n');
    }

    _getDayName(dateStr) {
        const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        const d = new Date(dateStr + 'T12:00:00');
        return days[d.getDay()];
    }

    // ===== AGENDAMENTOS =====

    /**
     * Cria novo agendamento no Feegow
     */
    async createAppointment({ pacienteId, profissionalId, especialidadeId, procedimentoId, data, horario, localId = 0, valor = 0, notas = '', celular = '', email = '' }) {
        const body = {
            local_id: localId,
            paciente_id: pacienteId,
            profissional_id: profissionalId,
            especialidade_id: especialidadeId,
            procedimento_id: procedimentoId,
            data: data, // DD-MM-YYYY
            horario: horario, // HH:MM:SS
            valor: valor,
            plano: 0,
            canal_id: this.canalId,
            notas: notas,
            celular: celular,
            email: email
        };

        const res = await this._post('/appoints/new-appoint', body);
        return {
            success: true,
            agendamento_id: res.content.agendamento_id,
            link: res.content.link
        };
    }

    /**
     * Busca agendamentos por filtros
     */
    async searchAppointments(filters = {}) {
        const params = {};
        if (filters.pacienteId) params.paciente_id = filters.pacienteId;
        if (filters.profissionalId) params.profissional_id = filters.profissionalId;
        if (filters.dataStart) params.data_start = filters.dataStart;
        if (filters.dataEnd) params.data_end = filters.dataEnd;
        if (filters.agendamentoId) params.agendamento_id = filters.agendamentoId;

        const res = await this._get('/appoints/search', params);
        return res.content || [];
    }

    /**
     * Cancela um agendamento
     */
    async cancelAppointment(agendamentoId, motivoId = 1, obs = '') {
        const res = await this._post('/appoints/cancel-appoint', {
            agendamento_id: agendamentoId,
            motivo_id: motivoId,
            obs: obs
        });
        return { success: true, message: res.content };
    }

    /**
     * Remarca um agendamento
     */
    async rescheduleAppointment(agendamentoId, novaData, novoHorario, motivoId = 1, obs = '') {
        const res = await this._post('/appoints/reschedule', {
            agendamento_id: agendamentoId,
            motivo_id: motivoId,
            data: novaData, // DD-MM-YYYY
            horario: novoHorario, // HH:MM:SS
            obs: obs
        });
        return { success: true, message: res.content };
    }

    /**
     * Atualiza status de um agendamento
     */
    async updateAppointmentStatus(agendamentoId, statusId, obs = '') {
        const res = await this._post('/appoints/statusUpdate', {
            AgendamentoID: agendamentoId,
            StatusID: statusId,
            Obs: obs
        });
        return { success: true, message: res.content?.msg };
    }

    // ===== STATUS E MOTIVOS =====

    async listStatuses() {
        return this._cached('statuses', async () => {
            const res = await this._get('/appoints/status');
            return res.content;
        });
    }

    async listMotives() {
        return this._cached('motives', async () => {
            const res = await this._get('/appoints/motives');
            return res.content;
        });
    }

    async listChannels() {
        return this._cached('channels', async () => {
            const res = await this._get('/appoints/list-channel');
            return res.content;
        });
    }

    // ===== HELPERS DE DATA =====

    /**
     * Converte DD/MM/YYYY para DD-MM-YYYY (formato Feegow)
     */
    toFeegowDate(dateStr) {
        return dateStr.replace(/\//g, '-');
    }

    /**
     * Converte YYYY-MM-DD para DD-MM-YYYY
     */
    isoToFeegow(isoDate) {
        const [y, m, d] = isoDate.split('-');
        return `${d}-${m}-${y}`;
    }

    /**
     * Retorna data de hoje no formato DD-MM-YYYY
     */
    today() {
        const d = new Date();
        return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    }

    /**
     * Retorna data X dias a frente no formato DD-MM-YYYY
     */
    daysFromNow(days) {
        const d = new Date();
        d.setDate(d.getDate() + days);
        return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    }

    /**
     * Verifica se o token está configurado
     */
    isConfigured() {
        return !!this.token;
    }
}

module.exports = new FeegowClient();
