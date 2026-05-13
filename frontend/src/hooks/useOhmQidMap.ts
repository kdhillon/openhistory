import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

/**
 * useOhmQidMap — fetches the OHM osm_id → Wikidata QID mapping from our backend.
 * The backend caches the result (5-minute TTL) and proxies Overpass on cache miss.
 * Refresh forces a cache bust on the backend, useful after a user edits OHM.
 */
export function useOhmQidMap(): {
  map: Record<number, string>;
  refresh: () => void;
  isLoading: boolean;
  fetchedAt: string | null;
  count: number;
  error: string | null;
} {
  const [map, setMap] = useState<Record<number, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [force, setForce] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    const url = `${API_BASE}/ohm-qid-map${force ? '?force=true' : ''}`;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`GET /api/ohm-qid-map failed (${r.status})`);
        return r.json();
      })
      .then((data: { map: Record<string, string>; fetchedAt: string; count: number }) => {
        if (cancelled) return;
        const numKeyed: Record<number, string> = {};
        for (const [k, v] of Object.entries(data.map ?? {})) numKeyed[Number(k)] = v;
        setMap(numKeyed);
        setFetchedAt(data.fetchedAt);
        setCount(data.count);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [tick, force]);

  const refresh = useCallback(() => {
    setForce(true);
    setTick((t) => t + 1);
  }, []);

  return { map, refresh, isLoading, fetchedAt, count, error };
}
