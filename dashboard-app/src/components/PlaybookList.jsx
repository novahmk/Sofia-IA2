import { useEffect, useState } from 'react';
import { api } from '../api';

export default function PlaybookList() {
  const [playbooks, setPlaybooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    api.playbooks()
      .then((data) => setPlaybooks(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#888' }}>Carregando playbooks...</p>;
  if (!playbooks.length) return <p style={{ color: '#888' }}>Nenhum playbook salvo ainda. O sistema aprende com conversas bem-sucedidas.</p>;

  return (
    <div>
      <h2 style={styles.title}>Playbooks Aprendidos ({playbooks.length})</h2>
      {playbooks.map((pb, i) => {
        const rate = Math.round((pb.successRate || 0) * 100);
        const open = expanded === i;
        return (
          <div key={pb.id || i} style={styles.card} onClick={() => setExpanded(open ? null : i)}>
            <div style={styles.cardHeader}>
              <span style={styles.pattern}>{pb.pattern}</span>
              <div style={styles.meta}>
                <span style={{ ...styles.rateBadge, background: rate >= 80 ? '#22c55e' : '#f0a500' }}>
                  {rate}%
                </span>
                <span style={styles.uses}>{pb.usageCount || 0} usos</span>
                <span style={styles.agent}>{pb.agentType || '—'}</span>
              </div>
            </div>
            {open && (
              <p style={styles.response}>{pb.response}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  title:    { fontSize: 18, marginBottom: 16 },
  card:     { background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 10,
              padding: '12px 16px', marginBottom: 8, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  pattern:  { color: '#e2e8f0', fontSize: 13, fontWeight: 500, flex: 1 },
  meta:     { display: 'flex', gap: 8, alignItems: 'center' },
  rateBadge:{ fontSize: 11, padding: '2px 8px', borderRadius: 10, color: '#fff', fontWeight: 700 },
  uses:     { fontSize: 11, color: '#64748b' },
  agent:    { fontSize: 11, color: '#a78bfa', fontStyle: 'italic' },
  response: { marginTop: 10, color: '#94a3b8', fontSize: 12, lineHeight: 1.6,
              borderTop: '1px solid #1e1e1e', paddingTop: 10 },
};
