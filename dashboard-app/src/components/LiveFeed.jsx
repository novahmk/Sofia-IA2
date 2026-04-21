import { useSSE } from '../hooks/useSSE';

const TYPE_LABELS = {
  message_received: { label: '📥 Recebida', color: '#4f8ef7' },
  agent_routed:     { label: '🔀 Roteado',  color: '#f0a500' },
  message_sent:     { label: '✅ Enviada',   color: '#22c55e' },
};

function EventRow({ event }) {
  const meta = TYPE_LABELS[event.type] || { label: event.type, color: '#888' };
  const time = event.ts ? new Date(event.ts).toLocaleTimeString('pt-BR') : '--:--';

  return (
    <div style={styles.row}>
      <span style={{ ...styles.badge, background: meta.color }}>{meta.label}</span>
      <span style={styles.phone}>{event.phone || '—'}</span>
      {event.nome && <span style={styles.nome}>{event.nome}</span>}
      {event.agent && <span style={styles.agent}>[{event.agent}]</span>}
      <span style={styles.msg}>{event.message || event.intentionType || ''}</span>
      <span style={styles.time}>{time}</span>
    </div>
  );
}

export default function LiveFeed() {
  const { events, connected } = useSSE(80);

  return (
    <div>
      <div style={styles.header}>
        <h2 style={styles.title}>Feed em Tempo Real</h2>
        <span style={{ ...styles.dot, background: connected ? '#22c55e' : '#ef4444' }} />
        <span style={styles.status}>{connected ? 'Conectado' : 'Desconectado'}</span>
      </div>

      {events.length === 0 && (
        <p style={styles.empty}>Aguardando eventos... Envie uma mensagem no WhatsApp.</p>
      )}

      <div style={styles.feed}>
        {events.map((ev, i) => (
          <EventRow key={`${ev.ts}-${i}`} event={ev} />
        ))}
      </div>
    </div>
  );
}

const styles = {
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  title:  { margin: 0, fontSize: 18 },
  dot:    { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  status: { fontSize: 12, color: '#aaa' },
  empty:  { color: '#888', fontStyle: 'italic' },
  feed: {
    display: 'flex', flexDirection: 'column', gap: 6,
    maxHeight: 480, overflowY: 'auto',
    border: '1px solid #2a2a2a', borderRadius: 8, padding: 8,
    background: '#0d0d0d',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 8,
    borderBottom: '1px solid #1e1e1e', paddingBottom: 6, flexWrap: 'wrap',
  },
  badge: {
    fontSize: 11, padding: '2px 7px', borderRadius: 12,
    color: '#fff', fontWeight: 600, whiteSpace: 'nowrap',
  },
  phone: { color: '#7dd3fc', fontFamily: 'monospace', fontSize: 12 },
  nome:  { color: '#e2e8f0', fontSize: 12 },
  agent: { color: '#a78bfa', fontSize: 12, fontStyle: 'italic' },
  msg:   { color: '#cbd5e1', fontSize: 12, flex: 1, minWidth: 0,
           overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  time:  { color: '#64748b', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' },
};
