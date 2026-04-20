const leadMemory = require('./leadMemory');
const db = require('../database');

class FollowUpManager {
  constructor() {
    this._cronStarted = false;
  }

  async scheduleFollowUp(phone, days = 3, reason = 'sem_resposta') {
    const lead = await leadMemory.getOrCreateLead(phone);

    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + days);

    await leadMemory.updateLead(phone, {
      proximo_follow_up: nextDate.toISOString(),
      follow_up_count: (lead.follow_up_count || 0) + 1,
      etapa_funil: 'follow_up',
    });

    console.log(`[FOLLOW-UP] Agendado para ${phone} em ${days} dias. Motivo: ${reason}`);
    return nextDate;
  }

  async getLeadsReadyForFollowUp() {
    try {
      // Query real no PostgreSQL buscando leads com proximo_follow_up vencido
      const result = await db.query(
        `SELECT lead_id, data FROM leads
         WHERE (data->>'proximo_follow_up')::timestamptz <= NOW()
           AND data->>'etapa_funil' = 'follow_up'`
      );
      return result.rows.map(r => ({ phone: r.lead_id, ...r.data }));
    } catch (_e) {
      // Fallback em memória quando PostgreSQL não está disponível
      const allLeads = db.getAll('leads');
      const now = new Date();
      return Object.entries(allLeads)
        .filter(([, lead]) => {
          if (!lead || !lead.proximo_follow_up) return false;
          if (lead.etapa_funil !== 'follow_up') return false;
          return new Date(lead.proximo_follow_up) <= now;
        })
        .map(([phone, lead]) => ({ phone, ...lead }));
    }
  }

  startCron(sendMessageFn) {
    if (this._cronStarted) return;
    this._cronStarted = true;

    const INTERVAL_MS = 60 * 60 * 1000; // 1 hora

    const run = async () => {
      console.log('[FOLLOW-UP CRON] Verificando leads para follow-up...');
      try {
        const leads = await this.getLeadsReadyForFollowUp();
        console.log(`[FOLLOW-UP CRON] ${leads.length} lead(s) prontos`);
        for (const lead of leads) {
          try {
            const msg = `Olá, ${lead.nome || 'tudo bem'}! 😊 Eu sou a Sofia da Quality Hair. Ainda posso te ajudar com informações sobre nossa avaliação capilar gratuita?`;
            await sendMessageFn(lead.phone, msg);
            await leadMemory.updateLead(lead.phone, {
              etapa_funil: 'follow_up_enviado',
              proximo_follow_up: null,
            });
            console.log(`[FOLLOW-UP CRON] Enviado para ${lead.phone}`);
          } catch (err) {
            console.error(`[FOLLOW-UP CRON] Erro ao enviar para ${lead.phone}: ${err.message}`);
          }
        }
      } catch (err) {
        console.error('[FOLLOW-UP CRON] Erro geral:', err.message);
      }
    };

    // Executa imediatamente e depois a cada hora
    run();
    setInterval(run, INTERVAL_MS);
    console.log('[FOLLOW-UP CRON] Iniciado (intervalo: 1 hora)');
  }
}

module.exports = new FollowUpManager();