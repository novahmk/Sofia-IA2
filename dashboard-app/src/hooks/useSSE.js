import { useEffect, useRef, useState } from 'react';
import { createSSE } from '../api';

/**
 * Hook que abre e mantém uma conexão SSE com o backend.
 * Retorna { events, connected }.
 * @param {number} maxEvents — quantos eventos manter no estado (default 100)
 */
export function useSSE(maxEvents = 100) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    const es = createSSE((event) => {
      if (event.type === 'connected') {
        setConnected(true);
        // snapshot inicial de leads/stats vem pelo REST, não pelo SSE
        return;
      }
      setEvents((prev) => [event, ...prev].slice(0, maxEvents));
    });

    esRef.current = es;
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));

    return () => {
      es.close();
      setConnected(false);
    };
  }, [maxEvents]);

  return { events, connected };
}
