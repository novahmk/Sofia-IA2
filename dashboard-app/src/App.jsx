import { useState } from 'react';
import LiveFeed     from './components/LiveFeed';
import LeadList     from './components/LeadList';
import AgentStats   from './components/AgentStats';
import PlaybookList from './components/PlaybookList';
import KpiCards     from './components/KpiCards';

const TABS = [
  { id: 'live',      label: '📡 Live Feed'   },
  { id: 'leads',     label: '👥 Leads'       },
  { id: 'agents',    label: '🤖 Agentes'     },
  { id: 'playbooks', label: '📖 Playbooks'   },
];

export default function App() {
  const [tab, setTab] = useState('live');

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <span style={styles.logo}>Sofia IA</span>
        <span style={styles.sub}>Dashboard de Monitoramento</span>
      </header>

      <main style={styles.main}>
        <KpiCards />

        <nav style={styles.nav}>
          {TABS.map(t => (
            <button
              key={t.id}
              style={{ ...styles.tab, ...(tab === t.id ? styles.tabActive : {}) }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <section style={styles.content}>
          {tab === 'live'      && <LiveFeed />}
          {tab === 'leads'     && <LeadList />}
          {tab === 'agents'    && <AgentStats />}
          {tab === 'playbooks' && <PlaybookList />}
        </section>
      </main>
    </div>
  );
}

const styles = {
  app: { minHeight: '100vh', background: '#080808', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' },
  header: { padding: '16px 32px', borderBottom: '1px solid #1e1e2e',
            display: 'flex', alignItems: 'baseline', gap: 12 },
  logo: { fontSize: 22, fontWeight: 700, color: '#a78bfa' },
  sub:  { fontSize: 13, color: '#64748b' },
  main: { maxWidth: 1200, margin: '0 auto', padding: '24px 32px' },
  nav:  { display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #1e1e2e', paddingBottom: 0 },
  tab: {
    background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer',
    padding: '8px 16px', fontSize: 13, fontWeight: 500, borderBottom: '2px solid transparent',
  },
  tabActive: { color: '#a78bfa', borderBottomColor: '#a78bfa' },
  content: { paddingTop: 8 },
};
