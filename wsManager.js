/**
 * wsManager.js — WebSocket server para o dashboard em tempo real
 * Emite eventos: new_message, conversation_updated, handoff_requested,
 * appointment_created, system_alert, kpi_update
 */

const { WebSocketServer } = require('ws');
const { verifyToken } = require('./auth');

let wss = null;
const clients = new Set();

/**
 * Inicializa o WebSocket server atrelado ao HTTP server existente
 */
function init(httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: '/ws/dashboard' });

    wss.on('connection', (ws, req) => {
        // Extrair token da query string
        const url = new URL(req.url, `http://localhost`);
        const token = url.searchParams.get('token');
        const payload = token ? verifyToken(token) : null;

        if (!payload) {
            ws.close(4001, 'Unauthorized');
            return;
        }

        ws.user = payload;
        ws.isAlive = true;
        clients.add(ws);
        console.log(`🔌 WS Dashboard conectado: ${payload.name} (${payload.role})`);

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('close', () => {
            clients.delete(ws);
            console.log(`🔌 WS Dashboard desconectado: ${payload.name}`);
        });

        ws.on('error', () => {
            clients.delete(ws);
        });
    });

    // Heartbeat a cada 30s
    setInterval(() => {
        for (const ws of clients) {
            if (!ws.isAlive) {
                clients.delete(ws);
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30000);

    console.log('🔌 WebSocket Dashboard disponível em /ws/dashboard');
}

/**
 * Broadcast um evento para todos os clientes conectados
 */
function broadcast(type, data) {
    if (!wss) return;
    const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const ws of clients) {
        if (ws.readyState === 1) { // OPEN
            try { ws.send(msg); } catch (e) { /* ignore */ }
        }
    }
}

// Helpers de emissão
function emitNewMessage(data) { broadcast('new_message', data); }
function emitConversationUpdated(data) { broadcast('conversation_updated', data); }
function emitHandoffRequested(data) { broadcast('handoff_requested', data); }
function emitAppointmentCreated(data) { broadcast('appointment_created', data); }
function emitSystemAlert(data) { broadcast('system_alert', data); }
function emitKpiUpdate(data) { broadcast('kpi_update', data); }

function getConnectedCount() { return clients.size; }

module.exports = {
    init,
    broadcast,
    emitNewMessage,
    emitConversationUpdated,
    emitHandoffRequested,
    emitAppointmentCreated,
    emitSystemAlert,
    emitKpiUpdate,
    getConnectedCount,
};
