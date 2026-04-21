import { useEffect, useState } from 'react';
import { api } from '../api';

const STAGE_COLORS = {
  novo:       '#4f8ef7',
  interessado:'#f0a500',
  qualificado:'#a78bfa',
  agendado:   '#22c55e',
  cliente:    '#10b981',
  frio:       '#64748b',
};

export default function LeadList() {
  const [leads, setLeads] = useState([]);
  const [selected, setSelected] = useState(null);
  const [conv, setConv] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.leads()
      .then(setLeads)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function openConv(phone) {
    if (selected === phone) { setSelected(null); setConv([]); return; }
    setSelected(phone);
    api.conversation(phone).then(({ messages }) => setConv(messages || [])).catch(() => {});
  }

  if (loading) return <p style={{ color: '#888' }}>Carregando leads...</p>;
  if (!leads.length) return <p style={{ color: '#888' }}>Nenhum lead encontrado.</p>;

  return (
    <div>
      <h2 style={styles.title}>Leads ({leads.length})</h2>
      <table style={styles.table}>
        <thead>
          <tr>
            {['Telefone', 'Nome', 'Etapa', 'Última interação'].map(h => (
              <th key={h} style={styles.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {leads.map(lead => (
            <>
              <tr
                key={lead.phone}
                style={{ ...styles.tr, background: selected === lead.phone ? '#1a1a2e' : 'transparent' }}
                onClick={() => openConv(lead.phone)}
              >
                <td style={styles.td}><span style={styles.phone}>{lead.phone}</span></td>
                <td style={styles.td}>{lead.nome || '—'}</td>
                <td style={styles.td}>
                  <span style={{ ...styles.stage, background: STAGE_COLORS[lead.etapa_funil] || '#555' }}>
                    {lead.etapa_funil || 'novo'}
                  </span>
                </td>
                <td style={styles.td}>
                  {lead.ultima_interacao
                    ? new Date(lead.ultima_interacao).toLocaleString('pt-BR')
                    : '—'}
                </td>
              </tr>
              {selected === lead.phone && conv.length > 0 && (
                <tr key={`${lead.phone}-conv`}>
                  <td colSpan={4} style={styles.convCell}>
                    {conv.slice(-10).map((m, i) => (
                      <div key={i} style={{ ...styles.bubble, alignSelf: m.role === 'assistant' ? 'flex-end' : 'flex-start' }}>
                        <span style={{ color: m.role === 'assistant' ? '#a78bfa' : '#7dd3fc', fontSize: 10 }}>
                          {m.role === 'assistant' ? 'Sofia' : 'Cliente'}
                        </span>
                        <p style={styles.bubbleText}>{m.content}</p>
                      </div>
                    ))}
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const styles = {
  title: { fontSize: 18, marginBottom: 12 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #2a2a2a',
        color: '#94a3b8', fontWeight: 500 },
  tr: { cursor: 'pointer', transition: 'background 0.15s' },
  td: { padding: '8px 12px', borderBottom: '1px solid #1a1a1a', color: '#e2e8f0' },
  phone: { fontFamily: 'monospace', color: '#7dd3fc' },
  stage: { padding: '2px 8px', borderRadius: 10, fontSize: 11, color: '#fff', fontWeight: 600 },
  convCell: { background: '#111', padding: 12 },
  bubble: { display: 'flex', flexDirection: 'column', maxWidth: '70%', marginBottom: 8 },
  bubbleText: { margin: '2px 0 0', background: '#1e1e2e', borderRadius: 8, padding: '6px 10px',
                color: '#cbd5e1', fontSize: 12 },
};
