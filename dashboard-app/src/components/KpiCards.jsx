import { useEffect, useState } from 'react';
import { api } from '../api';

export default function KpiCards() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
  }, []);

  if (!stats) return null;

  const cards = [
    { label: 'Total de Leads', value: stats.totalLeads ?? '—', icon: '👥' },
    { label: 'Agendamentos', value: stats.byStage?.agendado ?? 0, icon: '📅' },
    { label: 'Qualificados', value: stats.byStage?.qualificado ?? 0, icon: '⭐' },
    { label: 'Top Playbook', value: stats.topPlaybooks?.[0]?.pattern?.slice(0, 20) ?? '—', icon: '📖', small: true },
  ];

  return (
    <div style={styles.grid}>
      {cards.map((c) => (
        <div key={c.label} style={styles.card}>
          <span style={styles.icon}>{c.icon}</span>
          <div>
            <div style={{ ...styles.value, fontSize: c.small ? 14 : 28 }}>{c.value}</div>
            <div style={styles.label}>{c.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  grid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 24 },
  card:  { background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 10,
           padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 },
  icon:  { fontSize: 28 },
  value: { fontWeight: 700, color: '#e2e8f0', lineHeight: 1.2 },
  label: { fontSize: 11, color: '#64748b', marginTop: 2 },
};
