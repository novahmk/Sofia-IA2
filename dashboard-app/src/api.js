// Configuração central da API — usa variáveis de ambiente do Vite
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const TOKEN = import.meta.env.VITE_API_TOKEN || '';

const headers = () => ({
  'Content-Type': 'application/json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
});

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
  return res.json();
}

export const api = {
  stats:    () => get('/api/stats'),
  leads:    () => get('/api/leads'),
  conversation: (phone) => get(`/api/conversations/${encodeURIComponent(phone)}`),
  playbooks:() => get('/api/playbooks'),
  agentStats: () => get('/api/agents/stats'),
};

export function createSSE(onEvent) {
  const url = TOKEN
    ? `${BASE}/api/sse?token=${encodeURIComponent(TOKEN)}`
    : `${BASE}/api/sse`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch (_) {}
  };
  es.onerror = () => {
    // Reconexão automática do browser após 3s
  };
  return es;
}
