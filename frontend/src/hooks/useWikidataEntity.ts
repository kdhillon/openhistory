import { useState, useEffect } from 'react';
import { fetchEntityForInfoPanel } from '../lib/wikidataApi';
import type { WikidataEntityInfo } from '../lib/wikidataApi';

/**
 * Live-fetches a Wikidata entity (for InfoPanel use when an OHM polygon is clicked
 * but we have no local feature for that QID). Returns null until the fetch resolves.
 */
export function useWikidataEntity(qid: string | null | undefined, lang: string = 'en'): {
  data: WikidataEntityInfo | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<WikidataEntityInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!qid) { setData(null); setLoading(false); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEntityForInfoPanel(qid, lang)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [qid, lang]);

  return { data, loading, error };
}
