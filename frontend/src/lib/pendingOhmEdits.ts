import { useEffect, useState, useCallback } from 'react';

/**
 * Pending OHM edits queue, persisted in localStorage.
 *
 * Each entry is a wikidata/wikipedia tag edit the user has staged from the
 * mapping modal. The user reviews them and publishes everything as a single
 * OSM changeset to avoid spamming OHM's changeset list with one-element edits.
 */
export interface PendingOhmEdit {
  osmType: 'relation' | 'node' | 'way';
  osmId: number;
  setTags: Record<string, string>;
  /** Display label for the review panel (polity title). */
  displayName: string;
  /** Wikidata QID being assigned — used for optimistic in-app recoloring. */
  polityQid: string;
  /** Per-edit comment that will end up in the changeset comment (joined). */
  comment: string;
  /** Epoch ms when this edit was queued. */
  addedAt: number;
}

const STORAGE_KEY = 'oh_pending_ohm_edits';

function readQueue(): PendingOhmEdit[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(edits: PendingOhmEdit[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
  // Notify same-tab listeners (the `storage` event only fires cross-tab).
  window.dispatchEvent(new CustomEvent('oh-pending-edits-changed'));
}

export function getPendingEdits(): PendingOhmEdit[] {
  return readQueue();
}

/**
 * Add (or replace if same osm element) a pending edit. Re-adding the same
 * element overwrites the prior queued edit — the user's last choice wins.
 */
export function addPendingEdit(edit: PendingOhmEdit): void {
  const queue = readQueue().filter(
    (e) => !(e.osmType === edit.osmType && e.osmId === edit.osmId),
  );
  queue.push(edit);
  writeQueue(queue);
}

export function removePendingEdit(osmType: PendingOhmEdit['osmType'], osmId: number): void {
  const queue = readQueue().filter((e) => !(e.osmType === osmType && e.osmId === osmId));
  writeQueue(queue);
}

export function clearPendingEdits(): void {
  writeQueue([]);
}

/**
 * Reactive hook that returns the live pending queue. Re-reads from
 * localStorage whenever any tab mutates it (storage event) or this tab
 * mutates it (custom event from writeQueue above).
 */
export function usePendingOhmEdits(): PendingOhmEdit[] {
  const [edits, setEdits] = useState<PendingOhmEdit[]>(() => readQueue());

  const sync = useCallback(() => setEdits(readQueue()), []);

  useEffect(() => {
    window.addEventListener('storage', sync);
    window.addEventListener('oh-pending-edits-changed', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('oh-pending-edits-changed', sync);
    };
  }, [sync]);

  return edits;
}
