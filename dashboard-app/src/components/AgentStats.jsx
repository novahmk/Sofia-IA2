import { useEffect, useState } from 'react';
import { api } from '../api';

const AGENT_COLORS = {
  commercial:     '#f0a500',
  technical:      '#4f8ef7',
  administrative: '#22c55e',
  context:        '#a78bfa',
};

export default function AgentStats() {
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.agentStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#888' }}>Carregando stats dos agentes...</p>;

  const agents = Object.entries(stats);
  if (!agents.length) return <p style={{ color: '#888' }}>Nenhum dado de agente ainda.</p>;

  const maxTotal = Math.max(...agents.map(([, v]) => (v.success || 0) + (v.failure || 0)), 1);

  return (
    <div>
      <h2 style={styles.title}>Performance dos Agentes</h2>
      <div style={styles.grid}>
        {agents.map(([agent, v]) => {
          const total = (v.success || 0) + (v.failure || 0);
          const rate = total ? Math.round((v.success / total) * 100) : 0;
          const barW = Math.round((total / maxTotal) * 100);
          const color = AGENT_COLORS[agent] || '#888';
          return (
            <div key={agent} style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...styles.agentName, color }}>{agent}</span>
                <span style={styles.rate}>{rate}% sucesso</span>
              </div>
              <div style={styles.barBg}>
                <div style={{ ...styles.bar, width: `${barW}%`, background: color }} />
              </div>
              <div style={styles.counts}>
                <span style={{ color: '#22c55e' }}>✓ {v.success || 0}</span>
                <span style={{ color: '#ef4444' }}>✗ {v.failure || 0}</span>
                <span style={{ color: '#94a3b8' }}>total {total}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  title: { fontSize: 18, marginBottom: 16 },
  grid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  card:  { background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 10, padding: 16 },
  agentName: { fontWeight: 700, fontSize: 14, textTransform: 'capitalize' },
  rate:  { fontSize: 12, color: '#94a3b8' },
  barBg: { height: 6, background: '#1e1e1e', borderRadius: 3, margin: '10px 0' },
  bar:   { height: '100%', borderRadius: 3, transition: 'width 0.4s' },
  counts:{ display: 'flex', gap: 12, fontSize: 12 },
};
