/**
 * OhmLabelConfirmModal — confirmation dialog before creating a place=country node on OHM.
 *
 * Shows a summary of the label that will be created (name, coordinates, dates, Wikidata QID)
 * and a "Save to OHM" button. The actual API call happens in the parent since it requires
 * OAuth token handling.
 */

import { useState } from 'react';
import type { FeatureProperties } from '../types';

interface Props {
  feature: FeatureProperties;
  lat: number;
  lng: number;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}

export function OhmLabelConfirmModal({ feature, lat, lng, onConfirm, onCancel, saving, error }: Props) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}
    >
      <div style={{
        background: '#1e2433',
        borderRadius: 12,
        padding: 24,
        maxWidth: 400,
        width: '90vw',
        color: '#e8eaf0',
        fontFamily: 'inherit',
      }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>
          Add Label to OpenHistoricalMap
        </h3>

        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            <Row label="Name" value={feature.title} />
            <Row label="Type" value="place=country" />
            <Row label="Coordinates" value={`${lat.toFixed(4)}, ${lng.toFixed(4)}`} />
            <Row label="Start date" value={feature.yearStart != null ? String(feature.yearStart) : '—'} />
            <Row label="End date" value={feature.yearEnd != null ? String(feature.yearEnd) : '—'} />
            {feature.wikidataQid && (
              <Row label="Wikidata" value={feature.wikidataQid} />
            )}
            {feature.wikipediaTitle && (
              <Row label="Wikipedia" value={feature.wikipediaTitle} />
            )}
          </tbody>
        </table>

        {error && (
          <div style={{
            marginTop: 12,
            padding: '8px 12px',
            background: 'rgba(244,67,54,0.15)',
            border: '1px solid rgba(244,67,54,0.3)',
            borderRadius: 6,
            fontSize: 12,
            color: '#ef9a9a',
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              background: 'transparent',
              border: '1px solid #556',
              borderRadius: 6,
              padding: '7px 16px',
              fontSize: 13,
              color: '#aab',
              cursor: saving ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={saving}
            style={{
              background: saving ? '#556' : '#4CAF50',
              border: 'none',
              borderRadius: 6,
              padding: '7px 16px',
              fontSize: 13,
              color: '#fff',
              cursor: saving ? 'default' : 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            {saving ? 'Saving...' : 'Save to OHM'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ padding: '4px 12px 4px 0', color: '#9a9a9a', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
        {label}
      </td>
      <td style={{ padding: '4px 0' }}>
        {value}
      </td>
    </tr>
  );
}
