import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslations } from '../lib/TranslationContext';
import maplibregl, { Map, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';
import { getPolityColorAtYear, activeParentAt, POLITY_PALETTES } from '../theme/polityPalettes';
import type { PaletteId, PolityForColor } from '../theme/polityPalettes';
import { CATEGORY_SVGS } from '../theme/icons';
import { encodeDate, eventDateRange, STEP_YEAR, decodeDate } from '../hooks/useTimeline';

// ---------------------------------------------------------------------------
// Territory label points — explode MultiPolygon features into ranked Points
// so each polity shows at most MAX_LABEL_PARTS labels (largest parts first).
// ---------------------------------------------------------------------------
const MAX_LABEL_PARTS = 3;

/** Parse an OHM ISO-ish date string (e.g. "1789", "1813-10-24", "-0509") into a year integer. */
function parseOhmYear(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = value.trim().match(/^(-)?(\d{1,4})/);
  if (!m) return null;
  const y = parseInt(m[2], 10);
  return m[1] === '-' ? -y : y;
}

/**
 * Build a minimal FeatureProperties for an OHM polygon whose wikidata QID
 * has no local feature in our DB. The InfoPanel detects the `wd:` id prefix
 * and live-fetches the rest from Wikidata.
 */
function makeWikidataStub(
  qid: string,
  tileName: string,
  tileProperties: Record<string, unknown> | undefined,
): FeatureProperties {
  const yearStart = parseOhmYear(tileProperties?.start_date);
  const yearEnd = parseOhmYear(tileProperties?.end_date);
  return {
    id: `wd:${qid}`,
    slug: '',
    title: tileName,
    wikipediaTitle: '',
    wikipediaSummary: '',
    wikipediaUrl: '',
    wikidataQid: qid,
    yearStart,
    yearEnd,
    monthStart: null,
    dayStart: null,
    monthEnd: null,
    dayEnd: null,
    dateIsFuzzy: false,
    dateRangeMin: null,
    dateRangeMax: null,
    locationName: '',
    locationSlug: null,
    categories: [],
    primaryCategory: 'other',
    featureType: 'polity',
  } as unknown as FeatureProperties;
}

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

function ringCentroid(ring: number[][]): [number, number] {
  const n = ring.length - 1;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}


function buildLabelPoints(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  type Part = { area: number; centroid: [number, number]; props: Record<string, unknown> };
  // Note: avoid `new Map()` — `Map` is shadowed by the maplibre-gl import above.
  const byPolity: Record<string, Part[]> = {};
  const unmatched: GeoJSON.Feature[] = [];

  for (const f of features) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const polityId = props.polityId as string | null;
    const geom = f.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
    const rings = geom.type === 'Polygon'
      ? [(geom as GeoJSON.Polygon).coordinates]
      : (geom as GeoJSON.MultiPolygon).coordinates;

    if (!polityId) {
      if (rings.length === 0) continue;
      const biggest = rings.reduce((best, r) => ringArea(r[0]) > ringArea(best[0]) ? r : best, rings[0]);
      if (!biggest[0]?.length) continue;
      unmatched.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ringCentroid(biggest[0]) }, properties: props });
      continue;
    }

    const parts = byPolity[polityId] ?? [];
    for (const r of rings) {
      if (!r[0]?.length) continue;
      parts.push({ area: ringArea(r[0]), centroid: ringCentroid(r[0]), props });
    }
    byPolity[polityId] = parts;
  }

  const matched: GeoJSON.Feature[] = [];
  for (const parts of Object.values(byPolity)) {
    parts.sort((a, b) => b.area - a.area);
    parts.slice(0, MAX_LABEL_PARTS).forEach((p, i) => {
      matched.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.centroid }, properties: { ...p.props, _labelRank: i + 1 } });
    });
  }

  return [...unmatched, ...matched];
}

// Linger window: 5 steps in the current unit, capped at 3 years.
const LINGER_STEPS = 5;
const LINGER_MAX = 3 * STEP_YEAR;

// Zoom offset added per polity type on top of the sitelinks-based base zoom.
// Higher = needs more zoom to appear. Major polities (empire, kingdom) show early;
// smaller or noisier types (principality, people, other) are held back.
const POLITY_ZOOM_OFFSET: Record<string, number> = {
  empire:        1,
  kingdom:       1,
  republic:      1,
  papacy:        1,
  sultanate:     2,
  confederation: 2,
  colony:        2,
  principality:  2,
  people:        3,
  other:         3,
};
// Principalities with no linked territory are hidden until this zoom level minimum.
const UNLINKED_PRINCIPALITY_MIN_ZOOM = 8;

// ─── Canvas icons ────────────────────────────────────────────────────────────
//
// Each event category gets a pre-rendered canvas image: colored circle + white
// Lucide icon. Lucide SVGs are bundled at build time via ?raw imports in
// icons.ts — no CDN requests, no CORS issues.
//
// Using a single image (vs separate circle + symbol layers) ensures the
// background and icon always come from the same GeoJSON feature, preventing
// mismatches when events stack at the same pixel.
//
const ICON_SIZE = 28; // canvas px; MapLibre icon-size scales this
const catIconName = (cat: Category) => `ev-${cat}`;

function loadCategoryIcons(map: Map): Promise<void> {
  return Promise.all(
    (Object.entries(CATEGORY_SVGS) as [Category, string][]).map(([category, rawSvg]) =>
      new Promise<void>((resolve) => {
        const color    = CATEGORY_COLORS[category];
        const name     = catIconName(category);
        // Lucide icons use stroke="currentColor"; replace with white
        const whiteSvg = rawSvg.replace(/currentColor/g, 'white');
        const blob     = new Blob([whiteSvg], { type: 'image/svg+xml' });
        const url      = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);

          const canvas  = document.createElement('canvas');
          canvas.width  = ICON_SIZE;
          canvas.height = ICON_SIZE;
          const ctx = canvas.getContext('2d')!;
          const cx  = ICON_SIZE / 2;
          const r   = cx - 1.5;

          // Colored background circle
          ctx.beginPath();
          ctx.arc(cx, cx, r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // White icon — Lucide SVGs are 24×24 viewBox, drawn at ~60% of canvas
          const pad = Math.round(ICON_SIZE * 0.2);
          ctx.drawImage(img, pad, pad, ICON_SIZE - pad * 2, ICON_SIZE - pad * 2);

          const { data } = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
          map.addImage(name, { width: ICON_SIZE, height: ICON_SIZE, data: new Uint8Array(data) });
          resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        img.src = url;
      })
    )
  ).then(() => {});
}

export interface StackInfo {
  index: number;
  total: number;
}

export interface ZoomRequest {
  feature: FeatureProperties;
  id: number;
  /** Direct coordinates fallback — used when the feature isn't in the loaded geojson window. */
  center?: [number, number];
}

interface Props {
  geojson: GeoJSON.FeatureCollection;
  territoriesGeojson?: GeoJSON.FeatureCollection;
  currentDateInt: number;
  stepSize: number;
  activeCategories: Set<Category>;
  showBorders: boolean;
  showOtherPolities: boolean;
  onSelectFeature: (props: FeatureProperties, stack: StackInfo) => void;
  zoomRequest?: ZoomRequest | null;
  /** Fit the map to a bounding box (used when selecting a major event chip). */
  fitBoundsRequest?: { bbox: [number, number, number, number]; id: number } | null;
  /** polityId → hideUntilYear: territories for these polities are hidden before that year */
  hiddenNations?: Map<string, number>;
  /** Polity IDs suppressed because a more-specific co-capital polity is active at this year */
  suppressedPolityIds?: Set<string>;
  /** Polity IDs whose territory polygon is visible — hides the capital dot only (not the territory) */
  polityIdsWithTerritory?: Set<string>;
  /** When false (default), territory polygon labels are hidden and all polity names show at their capital */
  showTerritoryLabels?: boolean;
  /** Called when user clicks an unmatched territory (no polity linked) */
  onUnmatchedTerritoryClick?: (hbName: string, polygonId: string, yearStart: number, yearEnd: number | null) => void;
  /** Called when user clicks × to unlink a single polygon from its polity */
  onUnlinkPolygon?: (polygonId: string) => void;
  /** When set, only events whose partOf[] includes this QID are shown */
  majorEventFilter?: string | null;
  /** Called once after the MapLibre map finishes loading — provides the map instance for editor components. */
  onMapReady?: (map: Map) => void;
  /** When true, disables all click handling (territory editor mode). */
  editorMode?: boolean;
  /** 'hb' shows historical-basemaps GeoJSON territories; 'ohm' shows live OHM vector tiles */
  territorySource?: 'hb' | 'ohm';
  /** Called when user clicks an OHM territory that has no Wikidata QID matched in our polities */
  onOhmTerritoryClick?: (
    ohmName: string,
    ohmWikidataQid: string | null,
    yearStart: number | null,
    yearEnd: number | null,
    osmType: 'relation' | 'node',
    osmId: number,
  ) => void;
  /** Called after rebuildColors with the set of polity IDs that are matched to a visible OHM territory */
  onOhmMatchedPolityIds?: (ids: Set<string>) => void;
  /** When true (default), events that ended within the last step linger as semi-transparent markers */
  showRecentEvents?: boolean;
  /** Show OHM border outlines + centroid labels (land_ohm_lines / land_ohm_centroids) */
  showOhm?: boolean;
  /** Show OHM admin fill polygons (boundaries layer from ohm_admin tileset) */
  showOhmAdmin?: boolean;
  /** Show OHM labels (country centroids + admin centroids + our polity centroid labels) */
  showLabels?: boolean;
  /** Polity color palette — 'polity-type' uses CATEGORY_COLORS; others assign one of a small palette per polity */
  polityPalette?: PaletteId;
  /** osm_id → Wikidata QID lookup served by our backend (proxied Overpass query, 5-min TTL). */
  ohmQidMap?: Record<number, string>;
  /** Maximum OHM admin_level to render on the map (default 2 = countries only). */
  maxAdminLevel?: number;
  /** User-preferred OHM label language (2-letter code). Falls back to name_en → name. */
  selectedLang?: string;
}


// Circles: regions and explicitly major cities (no events)
const LOCATION_MAJOR_FILTER = ['any',
  ['==', ['get', 'featureType'], 'region'],
  ['==', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Symbol icons: events only, zoom-gated by _minZoom
const EVENT_FILTER = ['all',
  ['==', ['get', 'featureType'], 'event'],
  ['<=', ['coalesce', ['get', '_minZoom'], 4], ['zoom']],
] as maplibregl.FilterSpecification;

// Labels: events + major location markers (combined filter for the text layer)
const MAJOR_FILTER = ['any',
  ['all',
    ['==', ['get', 'featureType'], 'event'],
    ['<=', ['coalesce', ['get', '_minZoom'], 4], ['zoom']],
  ],
  ['==', ['get', 'featureType'], 'region'],
  ['==', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Minor = cities that aren't explicitly major — zoom-gated
const MINOR_FILTER = ['all',
  ['==', ['get', 'featureType'], 'city'],
  ['!=', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Polities — hollow rings, rendered on their own layers
const POLITY_FILTER = ['==', ['get', 'featureType'], 'polity'] as maplibregl.FilterSpecification;

function applyBorderVisibility(map: Map, visible: boolean) {
  const visibility = visible ? 'visible' : 'none';
  map.getStyle().layers.forEach((layer) => {
    const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
    if (sourceLayer === 'boundary') {
      map.setLayoutProperty(layer.id, 'visibility', visibility);
    }
  });
}

interface HoveredLabel {
  polygonId: string;
  hbName: string;
  x: number;
  y: number;
}

export function MapView({ geojson, territoriesGeojson, currentDateInt, stepSize, activeCategories, showBorders, showOtherPolities, showTerritoryLabels = false, onSelectFeature, zoomRequest, fitBoundsRequest, hiddenNations, suppressedPolityIds, polityIdsWithTerritory, onUnmatchedTerritoryClick, onUnlinkPolygon, majorEventFilter, onMapReady, editorMode, territorySource = 'hb', onOhmTerritoryClick, onOhmMatchedPolityIds, showRecentEvents = false, showOhm = true, showOhmAdmin = false, polityPalette = 'polity-type', ohmQidMap = {}, maxAdminLevel = 2, showLabels = true, selectedLang = 'en' }: Props) {
  const translationMap = useTranslations();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const updateFilterRef = useRef<() => void>(() => {});
  const territoriesGeojsonRef = useRef(territoriesGeojson);
  territoriesGeojsonRef.current = territoriesGeojson;
  const geojsonRef = useRef(geojson);
  geojsonRef.current = geojson;
  const suppressedPolityIdsRef = useRef(suppressedPolityIds ?? new Set<string>());
  suppressedPolityIdsRef.current = suppressedPolityIds ?? new Set<string>();
  const polityIdsWithTerritoryRef = useRef(polityIdsWithTerritory ?? new Set<string>());
  polityIdsWithTerritoryRef.current = polityIdsWithTerritory ?? new Set<string>();
  const showTerritoryLabelsRef = useRef(showTerritoryLabels);
  showTerritoryLabelsRef.current = showTerritoryLabels;
  const showBordersRef = useRef(showBorders);
  showBordersRef.current = showBorders;
  const territorySourceRef = useRef(territorySource);
  territorySourceRef.current = territorySource;
  const showOhmRef = useRef(showOhm);
  showOhmRef.current = showOhm;
  const showOhmAdminRef = useRef(showOhmAdmin);
  showOhmAdminRef.current = showOhmAdmin;
  const polityPaletteRef = useRef(polityPalette);
  polityPaletteRef.current = polityPalette;
  // currentDateInt is read inside rebuildColors, which lives in a useEffect with
  // empty deps — so without a ref, every invocation would see the first-render
  // year. Keep the ref synced each render so the parent-cascade resolves against
  // the live timeline year.
  const currentDateIntRef = useRef(currentDateInt);
  currentDateIntRef.current = currentDateInt;
  const ohmQidMapRef = useRef(ohmQidMap);
  ohmQidMapRef.current = ohmQidMap;
  const maxAdminLevelRef = useRef(maxAdminLevel);
  maxAdminLevelRef.current = maxAdminLevel;
  const selectedLangRef = useRef(selectedLang);
  selectedLangRef.current = selectedLang;
  // translationMap is consumed inside rebuildColors, which lives in a
  // useEffect with empty deps — so without a ref, every invocation would
  // see the initial empty object. Keep the ref synced each render so
  // OHM-label translations refresh as the batch fetch fills the map.
  const translationMapRef = useRef<Record<string, string>>({});
  translationMapRef.current = translationMap;
  const onOhmTerritoryClickRef = useRef(onOhmTerritoryClick);
  onOhmTerritoryClickRef.current = onOhmTerritoryClick;
  const [showModernBorders, setShowModernBorders] = useState(false);
  const showModernBordersRef = useRef(showModernBorders);
  showModernBordersRef.current = showModernBorders;
  const [hoveredLabel, setHoveredLabel] = useState<HoveredLabel | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache the first-seen screen position per territory name so re-hovering the same label
  // always shows the × at the same spot. Cleared on map move to avoid stale positions.
  const hbLabelPosCache = useRef<Record<string, { x: number; y: number }>>({});
  const rebuildColorsRef = useRef<() => void>(() => {});
  const centroidPolityIdsRef = useRef<Set<string>>(new Set());
  const onUnlinkPolygonRef = useRef(onUnlinkPolygon);
  onUnlinkPolygonRef.current = onUnlinkPolygon;
  const onOhmMatchedPolityIdsRef = useRef(onOhmMatchedPolityIds);
  onOhmMatchedPolityIdsRef.current = onOhmMatchedPolityIds;

  useEffect(() => {
    const container = containerRef.current;
    // Guard 1: skip if no container, already initialized, or container detached from DOM
    // (React 18 Strict Mode runs effects twice; the second run must not re-create the map
    //  on a container that MapLibre already removed its canvas from)
    if (!container || mapRef.current || !container.isConnected) return;

    let savedCenter: [number, number] = [20, 35];
    let savedZoom = 3;
    try {
      const c = localStorage.getItem('oh-map-center');
      const z = localStorage.getItem('oh-map-zoom');
      if (c) { const parsed = JSON.parse(c); if (Array.isArray(parsed) && parsed.length === 2) savedCenter = parsed as [number, number]; }
      if (z) { const n = parseFloat(z); if (isFinite(n)) savedZoom = n; }
    } catch { /* ignore */ }

    const map = new maplibregl.Map({
      container,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: savedCenter,
      zoom: savedZoom,
      attributionControl: false,
      // Replace unavailable font variants with Regular to suppress 404s
      transformStyle: (_prev, next) => {
        if (!next?.layers) return next;
        for (const layer of next.layers) {
          const tf = (layer as { layout?: { 'text-font'?: string[] } }).layout?.['text-font'];
          if (Array.isArray(tf)) {
            for (let i = 0; i < tf.length; i++) {
              tf[i] = tf[i]
                .replace('Open Sans Semibold', 'Open Sans Regular')
                .replace('Open Sans Bold', 'Open Sans Regular')
                .replace('Open Sans Italic', 'Open Sans Regular')
                .replace('Arial Unicode MS Bold', 'Arial Unicode MS Regular');
            }
          }
        }
        return next;
      },
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', async () => {
      // Guard 2: bail out if this map instance was removed before load fired
      // (happens in Strict Mode when cleanup runs before the async load event)
      if (mapRef.current !== map) return;
      // Icons must be registered before layers render, so load them first.
      await loadCategoryIcons(map);
      // Guard 3: re-check after the async gap — cleanup may have run during the await
      if (mapRef.current !== map) return;

      map.addSource('features', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      const circlePaint = {
        'circle-color': ['coalesce', ['get', '_color'], '#9E9E9E'],
        'circle-radius': ['case',
          ['has', '_radius'],                                 ['get', '_radius'],
          ['==', ['get', 'featureType'], 'region'],           11,
          ['==', ['get', 'cityImportance'], 'major'],         9,
          ['==', ['get', 'featureType'], 'city'],             6,
          6,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case',
          ['==', ['get', 'featureType'], 'region'],  3,
          2,
        ],
        'circle-opacity': ['number', ['get', '_opacity'], 1.0],
      };

      const labelLayout = {
        'text-field': ['get', 'title'],
        // Events bumped 20% over locations (war stays the most prominent).
        'text-size': ['case',
          ['==', ['get', 'primaryCategory'], 'war'], 14,
          ['==', ['get', 'featureType'], 'event'], 11,
          10,
        ],
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-max-width': 12,
        'text-optional': true,
        // Events get plain bold (more prominent than location labels), other
        // features (regions, cities) stay plain italic. Both font stacks are
        // among the few the OpenFreeMap font CDN actually serves.
        'text-font': [
          'case',
          ['==', ['get', 'featureType'], 'event'],
          ['literal', ['Noto Sans Bold', 'Arial Unicode MS Regular']],
          ['literal', ['Noto Sans Italic', 'Arial Unicode MS Regular']],
        ],
      };

      const labelPaint = {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1.0,
        'text-opacity': ['number', ['get', '_labelOpacity'], 1.0],
      };

      // Territory polygons — rendered first (bottommost layer)
      map.addSource('territories', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Separate point source for territory labels — one point per polygon part,
      // ranked by area so we can limit each polity to its 3 largest parts.
      map.addSource('territory-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      const hbInitialVis = territorySourceRef.current !== 'ohm' ? 'visible' : 'none';
      map.addLayer({
        id: 'fills-territory',
        type: 'fill',
        source: 'territories',
        layout: { visibility: hbInitialVis },
        paint: {
          'fill-color': ['coalesce', ['get', '_color'], '#607D8B'],
          'fill-opacity': 0.22,
        },
      });
      map.addLayer({
        id: 'borders-territory',
        type: 'line',
        source: 'territories',
        layout: { visibility: hbInitialVis },
        paint: {
          'line-color': ['coalesce', ['get', '_color'], '#607D8B'],
          'line-width': 1.2,
          'line-opacity': 0.6,
        },
      });
      // Territory labels — sourced from territory-labels (exploded points, ranked by area).
      // Each polity shows at most 3 labels (its 3 largest polygon parts).
      map.addLayer({
        id: 'labels-territory',
        type: 'symbol',
        source: 'territory-labels',
        filter: ['any',
          ['!', ['has', '_labelRank']],        // unmatched — always label
          ['<=', ['get', '_labelRank'], 3],     // matched — top 3 largest parts only
        ] as maplibregl.FilterSpecification,
        layout: {
          visibility: hbInitialVis,
          'text-field': ['coalesce', ['get', 'polityName'], ['get', 'hbName']],
          'text-size': 10,
          'text-max-width': 10,
          'text-optional': true,
          'text-font': ['Open Sans Italic', 'Arial Unicode MS Regular'],
        },
        paint: {
          'text-color': [
            'case',
            ['!=', ['get', 'polityId'], null], '#eeeeee',
            '#bebebe',
          ],
          'text-halo-color': [
            'case',
            ['!=', ['get', 'polityId'], null], 'rgba(0,0,0,0.6)',  // mapped → softer halo
            '#000000',                                              // unmapped → opaque black
          ],
          'text-halo-width': 1.5,
        },
      });

      // ── OHM vector tile sources + layers ─────────────────────────────────────
      // Two OHM tile endpoints are used:
      //   1. 'ohm' (general tileset) — has land_ohm_lines (border lines) and
      //      land_ohm_centroids (label points) at ALL zoom levels including z0-5.
      //   2. 'ohm_admin' — has fill polygons ('boundaries' layer) but the tile server
      //      drops some features at low zoom due to geometry simplification thresholds.
      // By combining both, territories like the Maratha Confederacy are visible at every
      // zoom level: borders+labels from 'ohm', colored fills from 'ohm_admin' at z6+.
      const OHM_FILLS_LAYER = 'boundaries';
      const OHM_LINES_LAYER = 'land_ohm_lines';
      const ohmInitialVis = showOhmRef.current ? 'visible' : 'none';
      const ohmAdminInitialVis = showOhmAdminRef.current ? 'visible' : 'none';
      const initialYear = decodeDate(currentDateInt).year;
      // Temporal + admin_level filter shared by all OHM admin layers. The level
      // ceiling comes from the user setting (default 2 = countries only).
      const OHM_ADMIN_FILTER = ['all',
        ['<=', ['get', 'admin_level'], maxAdminLevelRef.current],
        ['has', 'start_decdate'],
        ['<=', ['get', 'start_decdate'], initialYear],
        ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], initialYear]],
      ] as maplibregl.FilterSpecification;
      const OHM_ATTRIBUTION = '© <a href="https://www.openhistoricalmap.org" target="_blank">OpenHistoricalMap</a> contributors';

      // Source 1: ohm_admin — fill polygons (for color matching, clicking)
      map.addSource('ohm-admin', {
        type: 'vector',
        tiles: ['https://vtiles.openhistoricalmap.org/maps/ohm_admin/{z}/{x}/{y}.pbf'],
        maxzoom: 14,
        attribution: OHM_ATTRIBUTION,
      });
      // Source 2: ohm — border lines + centroid labels (available at all zoom levels)
      map.addSource('ohm', {
        type: 'vector',
        tiles: ['https://vtiles.openhistoricalmap.org/maps/ohm/{z}/{x}/{y}.pbf'],
        maxzoom: 14,
        attribution: OHM_ATTRIBUTION,
      });

      // OHM border lines from 'ohm' tileset (level 1 + 2) — drawn first (below polygons)
      const ohmTemporalOnly = ['all',
        ['has', 'start_decdate'],
        ['<=', ['get', 'start_decdate'], initialYear],
        ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], initialYear]],
      ] as maplibregl.FilterSpecification;
      // Level 1
      map.addLayer({
        id: 'ohm-borders-1',
        type: 'line',
        source: 'ohm',
        'source-layer': OHM_LINES_LAYER,
        filter: ['all', ['==', ['get', 'admin_level'], 1], ...ohmTemporalOnly.slice(1)] as maplibregl.FilterSpecification,
        layout: { visibility: ohmInitialVis },
        paint: { 'line-color': '#90A4AE', 'line-width': 1.8, 'line-opacity': 1 },
      });
      // Level 2
      map.addLayer({
        id: 'ohm-borders',
        type: 'line',
        source: 'ohm',
        'source-layer': OHM_LINES_LAYER,
        filter: ['all', ['==', ['get', 'admin_level'], 2], ...ohmTemporalOnly.slice(1)] as maplibregl.FilterSpecification,
        layout: { visibility: ohmInitialVis },
        paint: { 'line-color': '#90A4AE', 'line-width': 1.8, 'line-opacity': 1 },
      });
      // Fill polygons from ohm_admin — drawn on top of border lines.
      // `fill-sort-key` forces a deterministic render order. Primary key is
      // admin_level (broader polities render below finer subdivisions); within
      // the same admin level, osm_id (mod 10000 to stay in float-safe range)
      // breaks ties — same value in every tile, so the order doesn't flip
      // across tile boundaries.
      map.addLayer({
        id: 'ohm-fills',
        type: 'fill',
        source: 'ohm-admin',
        'source-layer': OHM_FILLS_LAYER,
        filter: OHM_ADMIN_FILTER,
        layout: {
          visibility: ohmAdminInitialVis,
          'fill-sort-key': ['+',
            ['*', ['coalesce', ['get', 'admin_level'], 0], 10000],
            ['%', ['abs', ['coalesce', ['get', 'osm_id'], 0]], 10000],
          ],
        },
        paint: { 'fill-color': '#78909C', 'fill-opacity': 0.22 },
      });
      // Thin polygon outline from ohm_admin (on top of fills)
      map.addLayer({
        id: 'ohm-polygon-borders',
        type: 'line',
        source: 'ohm-admin',
        'source-layer': OHM_FILLS_LAYER,
        filter: OHM_ADMIN_FILTER,
        layout: { visibility: ohmAdminInitialVis },
        paint: { 'line-color': '#90A4AE', 'line-width': 1.5, 'line-opacity': 1 },
      });
      // Large country labels from place_points_centroids (type=country).
      // Complete at all zoom levels — this is what the OHM website uses for major nations.
      map.addLayer({
        id: 'ohm-labels',
        type: 'symbol',
        source: 'ohm',
        'source-layer': 'place_points_centroids',
        filter: ['all',
          ['==', ['get', 'type'], 'country'],
          ['has', 'start_decdate'],
          ['<=', ['get', 'start_decdate'], initialYear],
          ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], initialYear]],
        ] as maplibregl.FilterSpecification,
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-size': 10,
          'symbol-sort-key': 0,  // initialized so rebuildColors can setLayoutProperty later
          'text-max-width': 10,
          'text-optional': true,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          visibility: ohmInitialVis,
        },
        paint: {
          'text-color': '#bebebe',
          'text-halo-color': '#000000',  // default = unmapped (black). Overridden per-name in rebuildColors.
          'text-halo-width': 1.5,
        },
      });
      // Admin-boundary labels from land_ohm_centroids — kept at the same size as
      // ohm-labels so users don't see size differences driven by OHM's tile schema
      // (which puts some entities in place_points_centroids and others in
      // land_ohm_centroids based on whether they have a place=country node).
      map.addLayer({
        id: 'ohm-labels-small',
        type: 'symbol',
        source: 'ohm',
        'source-layer': 'land_ohm_centroids',
        minzoom: 3,
        filter: OHM_ADMIN_FILTER,
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-size': 10,
          'symbol-sort-key': 0,  // initialized so rebuildColors can setLayoutProperty later
          'text-max-width': 8,
          'text-optional': true,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          visibility: ohmInitialVis,
        },
        paint: {
          'text-color': '#bebebe',
          'text-halo-color': '#000000',  // default = unmapped (black). Overridden per-name in rebuildColors.
          'text-halo-width': 1,
        },
      });
      // Hide HB territory layers if starting in OHM mode, or hide just labels if showTerritoryLabels is off
      if (territorySourceRef.current === 'ohm') {
        for (const id of ['fills-territory', 'borders-territory', 'labels-territory']) {
          map.setLayoutProperty(id, 'visibility', 'none');
        }
      } else if (!showTerritoryLabelsRef.current) {
        map.setLayoutProperty('labels-territory', 'visibility', 'none');
      }
      // Centroid labels: visible when territory labels toggle is OFF (regardless of source)
      if (showTerritoryLabelsRef.current) {
        map.setLayoutProperty('polity-centroid-labels', 'visibility', 'none');
      }

      // Polity zoom filter: same _minZoom convention as events
      const POLITY_ZOOM_FILTER = ['all',
        ['==', ['get', 'featureType'], 'polity'],
        ['<=', ['coalesce', ['get', '_minZoom'], 2], ['zoom']],
      ] as maplibregl.FilterSpecification;

      map.addLayer({
        id: 'labels-polity',
        type: 'symbol',
        source: 'features',
        filter: ['all',
          ['==', ['get', 'featureType'], 'polity'],
          ['<=', ['coalesce', ['get', '_minZoom'], 2], ['zoom']],
          ['!', ['coalesce', ['get', '_hasTerritory'], false]],
        ] as maplibregl.FilterSpecification,
        layout: { ...labelLayout, 'text-offset': [0, 1.6], 'text-size': 10 },
        paint: labelPaint,
      });

      // Capital star: shown at the centre of every polity.
      // Uses _starMinZoom: mapped polities only show star when zoomed in (z7+),
      // unmapped polities use _minZoom. Shows capital name as label when available.
      map.addLayer({
        id: 'stars-polity',
        type: 'symbol',
        source: 'features',
        filter: ['all',
          ['==', ['get', 'featureType'], 'polity'],
          ['<=', ['coalesce', ['get', '_starMinZoom'], ['get', '_minZoom'], 2], ['zoom']],
        ] as maplibregl.FilterSpecification,
        layout: {
          'icon-image': 'star',
          'icon-size': 0.9,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['coalesce', ['get', '_capitalLabel'], ''],
          'text-size': 9,
          'text-offset': [0, 1.2],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-optional': true,
        },
        paint: {
          'icon-color': ['coalesce', ['get', '_color'], '#9E9E9E'],
          'icon-opacity': ['number', ['get', '_opacity'], 1.0],
          'text-color': '#bdbdbd',
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        },
      });

      // Location circles: regions, countries, major cities
      map.addLayer({ id: 'circles-major', type: 'circle', source: 'features', filter: LOCATION_MAJOR_FILTER, paint: circlePaint });

      // Event icons: single symbol layer using pre-rendered canvas images.
      // Background + icon are part of the same image, so they always come from
      // the same GeoJSON feature — no mismatch when events stack at one pixel.
      map.addLayer({
        id: 'events-major',
        type: 'symbol',
        source: 'features',
        filter: EVENT_FILTER,
        layout: {
          'icon-image': ['coalesce', ['get', '_icon'], 'marker'],
          'icon-size': ['interpolate', ['linear'], ['coalesce', ['get', '_radius'], 7], 5, 0.6, 7, 0.75, 9, 0.9, 12, 1.1],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': ['number', ['get', '_opacity'], 1.0],
        },
      });

      // Labels for events + major locations
      map.addLayer({ id: 'labels-major', type: 'symbol', source: 'features', filter: MAJOR_FILTER, layout: labelLayout, paint: labelPaint });

      // Minor cities: MapLibre natively hides this layer below zoom 7
      map.addLayer({ id: 'circles-minor', type: 'circle', source: 'features', filter: MINOR_FILTER, minzoom: 7, paint: circlePaint });
      map.addLayer({ id: 'labels-minor', type: 'symbol', source: 'features', filter: MINOR_FILTER, minzoom: 7, layout: labelLayout, paint: labelPaint });      // Polity centroid labels — uses same proven source+layer pattern as test labels.
      // Initialized with placeholder; replaced with real centroid data in updateFilter.
      map.addSource('polity-centroid-src', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { title: 'INIT' } },
        ]},
      });
      map.addLayer({
        id: 'polity-centroid-labels',
        type: 'symbol',
        source: 'polity-centroid-src',
        layout: {
          'text-field': ['get', 'title'],
          // Bigger labels for more globally significant polities (driven by Wikipedia
          // language-edition count). Tiers match the OHM-tile size scale.
          // Bigger labels for more globally significant polities.
          'text-size': [
            'step', ['coalesce', ['get', 'sitelinksCount'], 0],
            9,
            10, 10,
            25, 11,
            60, 12,
            120, 14,
          ],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        },
        paint: {
          'text-color': [
            'case',
            ['==', ['get', 'mapped'], true], '#eeeeee',  // mapped → white
            '#bebebe',                                      // unmapped → gray (lighter)
          ],
          'text-halo-color': [
            'case',
            ['==', ['get', 'mapped'], true], 'rgba(0,0,0,0.7)',  // mapped → softer halo
            '#000000',                                            // unmapped → opaque black
          ],
          'text-halo-width': 2,
        },
      });

      // Hide base map place labels — our own historical features provide this context
      map.getStyle().layers.forEach((layer) => {
        if (layer.type === 'symbol' && (layer as { 'source-layer'?: string })['source-layer'] === 'place') {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        }
      });

      // Apply initial modern border visibility from ref (in case toggle was hit before load)
      if (!showModernBordersRef.current) applyBorderVisibility(map, false);

      for (const layer of ['circles-major', 'circles-minor', 'events-major', 'stars-polity', 'fills-territory', 'labels-territory', 'polity-centroid-labels', 'ohm-fills', 'ohm-labels', 'ohm-labels-small']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }

      // Hover state for unmatched territory labels — show assignment UI on hover
      map.on('mouseenter', 'labels-territory', (e) => {
        if (!e.features?.length) return;
        const feat = e.features[0];
        const polityId = feat.properties?.polityId as string | null;
        if (!polityId) return;
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
        const polygonId = feat.properties?.polygonId as string;
        const pos = hbLabelPosCache.current[polygonId] ?? { x: e.point.x, y: e.point.y };
        hbLabelPosCache.current[polygonId] = pos;
        setHoveredLabel({ polygonId, hbName: feat.properties?.hbName as string, x: pos.x, y: pos.y });
      });
      map.on('mouseleave', 'labels-territory', () => {
        hideTimerRef.current = setTimeout(() => setHoveredLabel(null), 150);
      });

      updateFilterRef.current();
      onMapReadyRef.current?.(map);
    });

    map.on('moveend', () => {
      try {
        const { lng, lat } = map.getCenter();
        localStorage.setItem('oh-map-center', JSON.stringify([lng, lat]));
        localStorage.setItem('oh-map-zoom', String(map.getZoom()));
      } catch { /* ignore */ }
      // Invalidate label position cache so re-hovering after a pan/zoom picks up fresh coords.
      hbLabelPosCache.current = {};
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Toggle political boundary layers without reloading the style
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyBorderVisibility(map, showModernBorders);
  }, [showModernBorders]);

  // Toggle territory layer visibility based on settings
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const hbVis = territorySource !== 'ohm' ? 'visible' : 'none';
      const hbLabelVis = hbVis === 'visible' && showTerritoryLabels ? 'visible' : 'none';
      for (const id of ['fills-territory', 'borders-territory']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', hbVis);
      }
      if (map.getLayer('labels-territory')) map.setLayoutProperty('labels-territory', 'visibility', hbLabelVis);
      // OHM border lines (from 'ohm' tileset) — controlled by showBorders.
      // Labels are a separate toggle so users can turn off lines without losing
      // place names (and vice versa).
      const ohmBorderVis = showBorders ? 'visible' : 'none';
      for (const id of ['ohm-borders', 'ohm-borders-1']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', ohmBorderVis);
      }
      // OHM labels (country centroids + admin centroids) + our derived
      // polity-centroid-labels — controlled by showLabels.
      // polity-centroid-labels has an additional gate: the HB-territory-labels
      // toggle (showTerritoryLabels) preempts it, since the two label sources
      // would otherwise overlap.
      const labelVis = showLabels ? 'visible' : 'none';
      for (const id of ['ohm-labels', 'ohm-labels-small']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', labelVis);
      }
      const centroidVis = (!showTerritoryLabels && showLabels) ? 'visible' : 'none';
      if (map.getLayer('polity-centroid-labels')) map.setLayoutProperty('polity-centroid-labels', 'visibility', centroidVis);
      // OHM polygon fills + outlines (from 'ohm_admin' tileset) — controlled by showOhmAdmin
      const ohmAdminVis = showOhmAdmin ? 'visible' : 'none';
      for (const id of ['ohm-fills', 'ohm-polygon-borders']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', ohmAdminVis);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [territorySource, showBorders, showTerritoryLabels, showOhm, showOhmAdmin, showLabels]);

  // Update OHM temporal filter on every year tick
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (!map.getLayer('ohm-fills') && !map.getLayer('ohm-borders')) return;

    const year = decodeDate(currentDateInt).year;
    // Temporal filter: start_decdate and end_decdate are floats (e.g. 1852.9194)
    // Require start_decdate to exist — features without it have no temporal metadata
    // and would otherwise appear at all times (wrong for a historical atlas).
    // Missing end_decdate = still active (no end date), so allow those through.
    // Admin boundary layers (fills + labels) use admin_level <= maxAdminLevel.
    const cap = maxAdminLevelRef.current;
    const adminTemporalFilter = ['all',
      ['<=', ['get', 'admin_level'], cap],
      ['has', 'start_decdate'],
      ['<=', ['get', 'start_decdate'], year],
      ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], year]],
    ] as maplibregl.FilterSpecification;
    for (const id of ['ohm-fills', 'ohm-polygon-borders', 'ohm-labels-small']) {
      if (map.getLayer(id)) map.setFilter(id, adminTemporalFilter);
    }
    // Border lines: level 1 always (when shown), levels 2..cap rendered via ohm-borders.
    if (map.getLayer('ohm-borders-1')) map.setFilter('ohm-borders-1', ['all',
      ['==', ['get', 'admin_level'], 1],
      ['has', 'start_decdate'],
      ['<=', ['get', 'start_decdate'], year],
      ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], year]],
    ] as maplibregl.FilterSpecification);
    if (map.getLayer('ohm-borders')) map.setFilter('ohm-borders', ['all',
      ['>=', ['get', 'admin_level'], 2],
      ['<=', ['get', 'admin_level'], cap],
      ['has', 'start_decdate'],
      ['<=', ['get', 'start_decdate'], year],
      ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], year]],
    ] as maplibregl.FilterSpecification);
    // Country labels use place_points_centroids (type=country, no admin_level)
    const labelTemporalFilter = ['all',
      ['==', ['get', 'type'], 'country'],
      ['has', 'start_decdate'],
      ['<=', ['get', 'start_decdate'], year],
      ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], year]],
    ] as maplibregl.FilterSpecification;
    if (map.getLayer('ohm-labels')) map.setFilter('ohm-labels', labelTemporalFilter);
  }, [currentDateInt, maxAdminLevel]);

  // Auto-color OHM territories by matching rendered tile names against polity names.
  // OHM tiles have no 'wikidata' property, so we:
  //   1. Query rendered OHM features after each map idle (new tiles loaded)
  //   2. Strip date suffixes from name_en: "Republic of Venice (1510-1571)" → "Republic of Venice"
  //   3. Match stripped name (case-insensitive) against polity titles in geojson
  //   4. Build a ['match', name_en, ...fullName→color pairs, default] expression
  // Manual ohm_territory_links entries can override any auto-match.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const rebuildColors = () => {
      if (!map.getLayer('ohm-fills') && !map.getLayer('ohm-labels')) return;

      // Local features by Wikidata QID (for star suppression on the polity layer
      // when a polygon matches a polity we already have). The COLOR of OHM polygons
      // no longer requires a local match — see below.
      const polityIdByQid: Record<string, string> = {};
      // Parallel registry for the parent-cascade color resolver. polityKey is hashed
      // by capital-city QID when present so semantically-linked polities
      // (Spain / Spanish Empire / Crown of Castile, all Madrid-capital) pick the
      // same color. Falls back to title when no capital is set.
      const polityByQid: Record<string, PolityForColor> = {};
      // Capital → list of polities with that capital, used by the capital-sibling
      // cascade fallback (so e.g. Fascist Italy can inherit Kingdom of Italy's
      // color via shared "Rome" when its own Wikidata record has no parent link).
      const polityByCapital: Record<string, PolityForColor[]> = {};
      // QID → sitelinksCount — drives label text-size and symbol-sort-key on OHM tile
      // layers so globally significant polities (Roman Empire, China, etc.) get
      // larger labels and win label-collision battles. Kept as a side-map since
      // sitelinksCount isn't used by the color cascade itself.
      const sitelinksByQid: Record<string, number> = {};
      for (const f of geojsonRef.current.features) {
        const p = f.properties as FeatureProperties;
        if (!p.wikidataQid) continue;
        if (!polityIdByQid[p.wikidataQid]) polityIdByQid[p.wikidataQid] = p.id;
        if (p.featureType === 'polity' && !polityByQid[p.wikidataQid]) {
          const pfc: PolityForColor = {
            qid: p.wikidataQid,
            polityType: p.polityType,
            parents: p.parents,
            polityKey: p.capitalWikidataQid ?? p.title,
            capitalName: p.capitalName ?? null,
            yearStart: p.yearStart ?? null,
            yearEnd: p.yearEnd ?? null,
          };
          polityByQid[p.wikidataQid] = pfc;
          if (p.capitalName) {
            const key = p.capitalName.toLowerCase();
            (polityByCapital[key] ??= []).push(pfc);
          }
          if (typeof p.sitelinksCount === 'number') {
            sitelinksByQid[p.wikidataQid] = p.sitelinksCount;
          }
        }
      }
      /** Combine sitelinks, OHM admin_level, and polygon area into a single
       *  importance score per OHM tile name. Sitelinks alone biases toward modern
       *  successors (French Third Republic has fewer sitelinks than modern France
       *  even though it WAS France for 70 years), and lets tiny-but-famous
       *  modern entities (San Marino, Andorra) dominate big historical polities.
       *  We log-cap sitelinks and weight area more heavily so visual heft wins
       *  over mere notability. */
      const scoreToSize = (score: number): number => {
        if (score >= 180) return 14;
        if (score >= 130) return 12;
        if (score >= 80)  return 11;
        if (score >= 40)  return 10;
        return 9;
      };
      const sitelinksScore = (sl: number): number => {
        // log-capped: a country with 300 sitelinks scores roughly the same as one
        // with 100. Caps the modern-bias.  0→0, 10→16, 50→27, 100→32, 300→40 (cap).
        return sl <= 0 ? 0 : Math.min(40, Math.log10(sl + 1) * 16);
      };
      const adminLevelScore = (al: number): number => {
        if (al <= 2) return 40;   // international or country
        if (al === 3) return 20;  // state / 1st-level subdivision
        return 0;                 // 4+ (district, county, etc.)
      };
      const areaToScore = (area: number): number => {
        // area is in degrees². Russia ~3000, Bremen ~0.1. Log-scaled with a
        // bigger range than sitelinks so visual size dominates. Tiny → ~0,
        // small country (~10 deg²) → 75, continent (~3000) → 135.
        return area <= 0 ? 0 : Math.max(0, Math.log10(area + 0.01) * 25 + 50);
      };
      // Read via ref — the surrounding useEffect has [] deps, so closures over
      // the prop would be frozen at first render.
      const currentYear = decodeDate(currentDateIntRef.current).year;
      const resolveByQid = (qid: string): PolityForColor | null => polityByQid[qid] ?? null;
      const findCapitalSibling = (capitalName: string, year: number, excludeQid: string): PolityForColor | null => {
        const candidates = polityByCapital[capitalName.toLowerCase()];
        if (!candidates) return null;
        // Active at `year`, not the same polity, and prefer ones with an active parent
        // (so we actually cascade somewhere useful). Among ties, prefer the longest-running entity.
        const active = candidates.filter((c) =>
          c.qid !== excludeQid &&
          (c.yearStart == null || c.yearStart <= year) &&
          (c.yearEnd == null || c.yearEnd >= year)
        );
        if (active.length === 0) return null;
        const withParent = active.filter((c) => activeParentAt(c.parents, year));
        const pool = withParent.length > 0 ? withParent : active;
        pool.sort((a, b) => (a.yearStart ?? 0) - (b.yearStart ?? 0));
        return pool[0];
      };

      // queryRenderedFeatures can throw if the map's WebGL painter isn't ready.
      // This is safe to swallow — sourcedata/moveend will retry automatically.
      let rendered: maplibregl.MapGeoJSONFeature[];
      try {
        // Query the fill layer + both label layers. ohm-fills renders at every zoom level,
        // so including it ensures we still find names to color-match when zoomed out far
        // enough that label tiles have nothing in them. Centroid-label generation below
        // filters back down to the label layers only to avoid duplicate centroids.
        const queryLayers: string[] = [];
        if (map.getLayer('ohm-fills')) queryLayers.push('ohm-fills');
        if (map.getLayer('ohm-labels')) queryLayers.push('ohm-labels');
        if (map.getLayer('ohm-labels-small')) queryLayers.push('ohm-labels-small');
        if (queryLayers.length === 0) { return; }
        rendered = map.queryRenderedFeatures({ layers: queryLayers });
      } catch {
        return;
      }
      const fillPairs: (string | maplibregl.ExpressionSpecification)[] = [];
      const labelPairs: (string | maplibregl.ExpressionSpecification)[] = [];
      const textPairs: (string | maplibregl.ExpressionSpecification)[] = [];
      // Per-feature Wikidata translations keyed on the OHM tile's name_en —
      // wired into the labelText expression below when selectedLang !== 'en'.
      const wdTextPairs: (string | maplibregl.ExpressionSpecification)[] = [];
      // text-size & symbol-sort-key per OHM-tile name, driven by a combined
      // (sitelinks + admin_level + polygon area) importance score. Higher score
      // = bigger font + lower sort-key (wins label-collision).
      // We accumulate per-name signals across all rendered features (polygons +
      // label centroids), then convert to pairs in a single pass after the loop.
      const byNameSignal: Record<string, { sl: number; area: number; adminLevel: number }> = {};
      // Track the wikidata QIDs each name resolves to so we can pool area +
      // sitelinks across name variants sharing a QID (e.g. "Italy" polygon +
      // "Kingdom of Italy" label both tagged Q172579).
      const qidsByName: Record<string, Set<string>> = {};
      // Bake the palette's fill-opacity into colors so the paint layer can run at
      // opacity 1.0 (avoids tile-seam darkening).
      const paletteOpacity = POLITY_PALETTES[polityPaletteRef.current]?.fillOpacity ?? 0.22;
      const bakeAlpha = (hex: string, a: number): string => {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
        if (!m) return hex;
        const r = parseInt(m[1], 16);
        const g = parseInt(m[2], 16);
        const b = parseInt(m[3], 16);
        return `rgba(${r}, ${g}, ${b}, ${a})`;
      };
      const FALLBACK_FILL = bakeAlpha('#78909C', paletteOpacity);

      // Strip trailing " (YYYY)" / " (YYYY-YYYY)" / " (YYYY-present)" date suffixes
      // from OHM display names so the labels read cleanly on the map.
      const DATE_SUFFIX_RE = /\s*\(\d{1,4}(?:\s*[-–]\s*(?:\d{1,4}|present))?\)\s*$/;
      const stripDisplay = (s: string) => s.replace(DATE_SUFFIX_RE, '').trim();

      // For each rendered feature: look up its osm_id in the OHM QID map (served by our backend).
      // If a QID is found, color the polygon via QID hash — every wikidata-tagged OHM polygon
      // gets a color, regardless of whether we have a local feature for it. The local DB is
      // only consulted to suppress redundant stars and (on click) to skip the live fetch.
      const qidMap = ohmQidMapRef.current;
      // Dedupe sets are SEPARATE for match vs text-suffix-stripping. A name only
      // counts as "matched" once we've actually found a QID match for it, so a
      // label node with no wikidata processed first doesn't poison the slot
      // for the polygon relation with wikidata that comes later in the list.
      const matchedNames = new Set<string>();
      const seenForText = new Set<string>();
      const matchedPolityIds = new Set<string>();
      for (const f of rendered) {
        const fullName = (f.properties?.name_en ?? f.properties?.name ?? '') as string;
        if (!fullName) continue;

        const displayName = stripDisplay(fullName);

        // Strip date suffix from displayed label text — process once per name.
        if (!seenForText.has(fullName)) {
          seenForText.add(fullName);
          if (fullName !== displayName) textPairs.push(fullName, displayName);
        }

        // Accumulate importance signals per name across ALL features (polygons
        // contribute area, label nodes contribute admin_level, QID-matched
        // features contribute sitelinks). Done for both matched and unmatched
        // names so admin_level/area boost unmatched polities too.
        const sig = byNameSignal[fullName] ?? { sl: 0, area: 0, adminLevel: 99 };
        const absOsmIdEarly = Math.abs(Number(f.properties?.osm_id));
        if (absOsmIdEarly) {
          const qEarly = qidMap[absOsmIdEarly];
          if (qEarly) {
            const qset = qidsByName[fullName] ?? new Set<string>();
            qset.add(qEarly);
            qidsByName[fullName] = qset;
          }
        }
        const tileAdminLvl = Number(f.properties?.admin_level);
        if (!Number.isNaN(tileAdminLvl)) {
          sig.adminLevel = Math.min(sig.adminLevel, tileAdminLvl);
        } else if (f.layer?.id === 'ohm-labels') {
          // ohm-labels' source layer is `place_points_centroids` filtered to
          // `type=country`, so every feature there IS country-level even when
          // the tile omits an explicit admin_level. Treat as level 2.
          sig.adminLevel = Math.min(sig.adminLevel, 2);
        }
        const geom = f.geometry;
        if (geom?.type === 'Polygon') {
          const ring = (geom as GeoJSON.Polygon).coordinates[0];
          if (ring?.length) sig.area += ringArea(ring);
        } else if (geom?.type === 'MultiPolygon') {
          for (const polyRings of (geom as GeoJSON.MultiPolygon).coordinates) {
            if (polyRings[0]?.length) sig.area += ringArea(polyRings[0]);
          }
        }
        byNameSignal[fullName] = sig;

        // Match attempt — skip only if we've already colored this name.
        if (matchedNames.has(fullName)) continue;

        const osmId = Math.abs(Number(f.properties?.osm_id));
        const wikidataQid = osmId ? qidMap[osmId] : undefined;
        if (wikidataQid) {
          // Cascade: child polities resolve to parent color at the current year
          // when our DB has them linked; otherwise the QID itself is hashed as
          // the stable fallback (no polity-DB dependency).
          const polity: PolityForColor = polityByQid[wikidataQid] ?? { qid: wikidataQid };
          const color = getPolityColorAtYear(polity, currentYear, polityPaletteRef.current, resolveByQid, findCapitalSibling);
          matchedNames.add(fullName);
          // Bake the palette's fill-opacity into the color so we can render the
          // fill at opacity 1.0 on the paint side. Avoids the dark-seam artifact
          // where a polygon clipped across tile boundaries overpaints itself,
          // doubling effective alpha along the seam.
          fillPairs.push(fullName, bakeAlpha(color, paletteOpacity));
          labelPairs.push(fullName, '#eeeeee');
          sig.sl = sitelinksByQid[wikidataQid] ?? 0;
          const polityId = polityIdByQid[wikidataQid];
          if (polityId) matchedPolityIds.add(polityId);
          // Build name-keyed Wikidata translation pairs for the label text-field.
          // OHM tile schema doesn't expose every language (`name:de` etc.) so a
          // QID-keyed Wikidata lookup is our broader-coverage path. The match
          // expression below takes precedence over the date-suffix-strip pairs
          // for non-English language sessions.
          const wdTranslation = translationMapRef.current?.[wikidataQid];
          if (wdTranslation && wdTranslation !== fullName) {
            wdTextPairs.push(fullName, wdTranslation);
          }
        }
      }

      const nameExpr = ['coalesce', ['get', 'name_en'], ['get', 'name']] as unknown as maplibregl.ExpressionSpecification;
      const fillColor = fillPairs.length > 0
        ? (['match', nameExpr, ...fillPairs, FALLBACK_FILL] as unknown as maplibregl.ExpressionSpecification)
        : FALLBACK_FILL;
      // Unmapped polity label color — ~20% lighter than the original #9e9e9e
      // so the gray text reads as visually lighter without changing stroke weight.
      const UNMAPPED_LABEL_COLOR = '#bebebe';
      const labelColor = labelPairs.length > 0
        ? (['match', nameExpr, ...labelPairs, UNMAPPED_LABEL_COLOR] as unknown as maplibregl.ExpressionSpecification)
        : UNMAPPED_LABEL_COLOR;
      // Halo color — black for unmapped (gray text needs strong stroke for contrast),
      // softer rgba black for mapped (white text reads fine with a lighter halo).
      const haloPairs: (string | number)[] = [];
      for (let i = 0; i < labelPairs.length; i += 2) {
        haloPairs.push(labelPairs[i] as string, 'rgba(0,0,0,0.6)');  // mapped → softer halo
      }
      const labelHaloColor = haloPairs.length > 0
        ? (['match', nameExpr, ...haloPairs, '#000000'] as unknown as maplibregl.ExpressionSpecification)
        : '#000000';
      // Label text: mapped names strip date suffix; unmapped fall back to raw tile name.
      const baseLabelText = textPairs.length > 0
        ? (['match', nameExpr, ...textPairs, nameExpr] as unknown as maplibregl.ExpressionSpecification)
        : nameExpr;
      // When the user picks a non-English language, resolve the label as:
      //   1. OHM tile's own `name:<lang>` tag — when curated, usually best
      //   2. Wikidata translation matched on the feature's English name —
      //      broader coverage than OHM
      //   3. The English-based baseLabelText (stripped date-suffix or raw)
      const lang = selectedLangRef.current;
      const wdTextMatch = wdTextPairs.length > 0
        ? (['match', nameExpr, ...wdTextPairs, baseLabelText] as unknown as maplibregl.ExpressionSpecification)
        : baseLabelText;
      const labelText = lang && lang !== 'en'
        ? (['coalesce', ['get', `name:${lang}`], wdTextMatch] as unknown as maplibregl.ExpressionSpecification)
        : baseLabelText;

      if (map.getLayer('ohm-fills')) {
        map.setPaintProperty('ohm-fills', 'fill-color', fillColor);
        // Alpha is baked into each fill color above. Run the paint at opacity 1
        // so polygons clipped across tile seams overpaint identically rather
        // than multiplying their alpha.
        map.setPaintProperty('ohm-fills', 'fill-opacity', 1);
      }
      // ohm-borders uses land_ohm_lines which has no name_en — keep uniform gray.
      // The fill polygons provide per-territory coloring.
      // Build text-size + symbol-sort-key from the combined importance score per name.
      const textSizePairs: (string | number)[] = [];
      const textSortKeyPairs: (string | number)[] = [];
      // OHM tags the same entity with the same wikidata QID across multiple
      // features (e.g. a label node "Kingdom of Italy" + a polygon "Italy", both
      // tagged Q172579). Pool area + sitelinks by QID so label-only features
      // inherit their polygon counterpart's signals.
      const byQidArea: Record<string, number> = {};
      const byQidSl: Record<string, number> = {};
      for (const [n, s] of Object.entries(byNameSignal)) {
        const qset = qidsByName[n];
        if (!qset) continue;
        for (const q of qset) {
          if (s.area > (byQidArea[q] ?? 0)) byQidArea[q] = s.area;
          const dbSl = sitelinksByQid[q];
          if (dbSl !== undefined && dbSl > (byQidSl[q] ?? 0)) byQidSl[q] = dbSl;
        }
      }
      for (const [name, sig] of Object.entries(byNameSignal)) {
        const qset = qidsByName[name];
        let effectiveArea = sig.area;
        let effectiveSl = sig.sl;
        if (qset) {
          for (const q of qset) {
            const qa = byQidArea[q];
            if (qa !== undefined && qa > effectiveArea) effectiveArea = qa;
            const qs = byQidSl[q];
            if (qs !== undefined && qs > effectiveSl) effectiveSl = qs;
          }
        }
        const slScore = sitelinksScore(effectiveSl);
        const adminScore = adminLevelScore(sig.adminLevel);
        const areaScore = areaToScore(effectiveArea);
        const total = slScore + adminScore + areaScore;
        const size = scoreToSize(total);
        textSizePairs.push(name, size);
        textSortKeyPairs.push(name, -total);
      }
      const textSizeExpr = textSizePairs.length > 0
        ? (['match', nameExpr, ...textSizePairs, 10] as unknown as maplibregl.ExpressionSpecification)
        : 10;
      const textSortKeyExpr = textSortKeyPairs.length > 0
        ? (['match', nameExpr, ...textSortKeyPairs, 0] as unknown as maplibregl.ExpressionSpecification)
        : 0;
      for (const id of ['ohm-labels', 'ohm-labels-small']) {
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'text-color', labelColor);
          map.setPaintProperty(id, 'text-halo-color', labelHaloColor);
          map.setLayoutProperty(id, 'text-field', labelText);
          map.setLayoutProperty(id, 'text-size', textSizeExpr);
          map.setLayoutProperty(id, 'symbol-sort-key', textSortKeyExpr);
        }
      }

      // Build centroid labels from OHM rendered features.
      // Only consider features from the label layers — including ohm-fills here would
      // produce redundant centroids on top of the ones OHM already places via labels.
      const centroidSrc = map.getSource('polity-centroid-src') as GeoJSONSource | undefined;
      if (centroidSrc) {
        const labelRendered = rendered.filter((f) => f.layer.id === 'ohm-labels' || f.layer.id === 'ohm-labels-small');
        const byKey: Record<string, { area: number; centroid: [number, number]; name: string; mapped: boolean; polityId: string | null; sitelinks: number }> = {};
        // byKey now also tracks the source OHM osm_id+type so a click on the centroid
        // label can attach OHM context (for direct API edits from InfoPanel).
        const byKey2: Record<string, { area: number; centroid: [number, number]; name: string; mapped: boolean; polityId: string | null; osmId: number | null; osmType: 'node' | 'relation' | null; sitelinks: number }> = byKey as never;
        const lang = selectedLangRef.current;
        for (const f of labelRendered) {
          const fullName = (f.properties?.name_en ?? f.properties?.name ?? '') as string;
          if (!fullName) continue;
          const displayName = stripDisplay(fullName);
          const osmIdRaw = Number(f.properties?.osm_id);
          const osmId = Math.abs(osmIdRaw);
          const wikidataQid = osmId ? qidMap[osmId] : undefined;
          const polityId = wikidataQid ? (polityIdByQid[wikidataQid] ?? null) : null;
          const sitelinks = wikidataQid ? (sitelinksByQid[wikidataQid] ?? 0) : 0;
          // 'Mapped' (white label) means OHM has a wikidata tag, even if our DB doesn't know it.
          const isMapped = !!wikidataQid;
          // Resolve the localized label for this polity. Priority:
          //   1. OHM tile property `name:<lang>` — community-curated, often
          //      historical-accurate (e.g. "Heiliges Römisches Reich")
          //   2. Wikidata translation map keyed by the polity's QID — broader
          //      coverage than OHM
          //   3. English fallback (stripDisplay of name_en / name)
          let localizedName = displayName;
          if (lang && lang !== 'en') {
            const ohmLangName = f.properties?.[`name:${lang}`] as string | undefined;
            const wdLangName = wikidataQid ? translationMapRef.current?.[wikidataQid] : undefined;
            if (ohmLangName) {
              localizedName = stripDisplay(ohmLangName);
            } else if (wdLangName) {
              localizedName = wdLangName;
            }
          }
          const key = polityId ?? (wikidataQid ? `qid::${wikidataQid}` : `ohm::${fullName}`);
          // Label features in ohm-labels/ohm-labels-small are nodes; in ohm-fills they'd be relations.
          const osmType: 'node' | 'relation' = osmIdRaw < 0 ? 'relation' : 'node';
          const geom = f.geometry;
          if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
          const rings = geom.type === 'Polygon'
            ? [(geom as GeoJSON.Polygon).coordinates]
            : (geom as GeoJSON.MultiPolygon).coordinates;
          for (const r of rings) {
            if (!r[0]?.length) continue;
            const a = ringArea(r[0]);
            if (!byKey2[key] || a > byKey2[key].area) {
              byKey2[key] = { area: a, centroid: ringCentroid(r[0]), name: localizedName, mapped: isMapped, polityId, osmId: osmId || null, osmType, sitelinks };
            }
          }
        }
        const centroidFeatures: GeoJSON.Feature[] = Object.values(byKey2).map((v) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: v.centroid },
          properties: {
            title: v.name,
            mapped: v.mapped,
            featureType: 'territory',
            // Carry through so click handler can attach OHM context to the opened feature.
            _ohmOsmId: v.osmId,
            _ohmOsmType: v.osmType,
            // sitelinksCount drives the centroid label's text-size.
            sitelinksCount: v.sitelinks,
          },
        }));
        centroidSrc.setData({ type: 'FeatureCollection', features: centroidFeatures });

        // Suppress star labels for every polity that has a centroid label (mapped or not).
        const centroidIds = new Set<string>();
        for (const v of Object.values(byKey)) {
          if (v.polityId) {
            matchedPolityIds.add(v.polityId);
            centroidIds.add(v.polityId);
          }
        }
        centroidPolityIdsRef.current = centroidIds;
      }

      onOhmMatchedPolityIdsRef.current?.(matchedPolityIds);

      // Re-run updateFilter so _hasTerritory reflects the newly computed centroid IDs.
      // Without this, updateFilter may have run before OHM tiles loaded, leaving _hasTerritory stale.
      updateFilterRef.current();
    };

    rebuildColorsRef.current = rebuildColors;

    // Rebuild when OHM tiles finish loading. 'sourcedata' does not fire when
    // setPaintProperty is called, so there is no infinite loop.
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if ((e.sourceId === 'ohm-admin' || e.sourceId === 'ohm') && e.isSourceLoaded) rebuildColors();
    };
    // Also rebuild after panning/zooming to catch any new visible features.
    map.on('sourcedata', onSourceData);
    map.on('moveend', rebuildColors);
    return () => {
      map.off('sourcedata', onSourceData);
      map.off('moveend', rebuildColors);
    };
  // Empty deps: geojsonRef is always current — no need to re-register listeners.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run rebuildColors when the OHM QID map arrives (or refreshes), so polygons
  // recolor as soon as the join data is available rather than waiting for a map move.
  useEffect(() => {
    rebuildColorsRef.current();
  }, [ohmQidMap]);

  // Re-run rebuildColors when polities arrive in geojson, so the polityColorByQid index
  // is built from the loaded data (not the initial empty seed).
  useEffect(() => {
    rebuildColorsRef.current();
  }, [geojson]);

  // Re-run rebuildColors when the user picks a different polity palette.
  // resetPolityColorAssignments() in App already cleared the index map, so
  // each polity will pick a fresh random color from the new palette here.
  useEffect(() => {
    rebuildColorsRef.current();
  }, [polityPalette]);

  // Re-run rebuildColors when the UI language changes, so OHM labels switch
  // to the matching `name:<lang>` tag (with English fallback).
  useEffect(() => {
    rebuildColorsRef.current();
  }, [selectedLang]);

  // Re-run rebuildColors when the translation batch finishes (or refreshes).
  // Without this, the Wikidata-keyed fallback for ohm-labels and the
  // polity-centroid translated names would stay stuck at whatever
  // translationMap snapshot was active when the rebuildColors closure was
  // first captured — i.e. the empty {} from initial mount.
  useEffect(() => {
    rebuildColorsRef.current();
  }, [translationMap]);

  // Re-run rebuildColors when the timeline year changes — parent-cascade color
  // is year-gated (a polity may have one parent at 1820 and a different one at
  // 1900), so the color expression must be rebuilt.
  useEffect(() => {
    rebuildColorsRef.current();
  }, [currentDateInt]);

  const onSelectRef = useRef(onSelectFeature);
  onSelectRef.current = onSelectFeature;
  const onUnmatchedTerritoryRef = useRef(onUnmatchedTerritoryClick);
  onUnmatchedTerritoryRef.current = onUnmatchedTerritoryClick;
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const stackRef = useRef<{ ids: string[]; index: number } | null>(null);
  const ohmStackRef = useRef<{ names: string[]; index: number } | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Single map-level handler queries all clickable layers at once.
    // Layer-specific handlers would fire multiple times per click for stacked
    // war events (circles-major + icons-war both hit), corrupting the stack index.
    const CLICK_LAYERS = ['events-major', 'circles-major', 'circles-minor', 'stars-polity', 'fills-territory', 'labels-territory', 'polity-centroid-labels', 'ohm-fills', 'ohm-labels', 'ohm-labels-small'];

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (editorModeRef.current) return;
      const features = map.queryRenderedFeatures(e.point, { layers: CLICK_LAYERS });
      if (!features || features.length === 0) return;

      const top = features[0];

      // OHM territory click.
      // Priority:
      //   1. Direct Wikidata QID match against polities in geojson (auto, no manual linking needed)
      //   2. Manual ohm_territory_links override (name-keyed, for renames / overrides)
      //   3. No match → open OhmMappingModal
      if (top.layer.id === 'ohm-fills') {
        // Re-query specifically for ohm-fills to get ALL overlapping polygons at this point.
        const allOhmFeatures = map.queryRenderedFeatures(e.point, { layers: ['ohm-fills'] });
        const DATE_SUFFIX = /\s*\(\d{1,4}(?:\s*[-–]\s*(?:\d{1,4}|present))?\)\s*$/;
        const stripName = (s: string) => s.replace(DATE_SUFFIX, '').trim();

        // Resolve an OHM tile feature to its matched polity via osm_id → QID lookup
        // (the OHM tile generator strips the wikidata tag, so we join through our
        // backend-served ohmQidMap).
        const resolvePolity = (f: maplibregl.MapGeoJSONFeature) => {
          const osmId = Math.abs(Number(f.properties?.osm_id));
          const wikidataQid = osmId ? ohmQidMapRef.current[osmId] : undefined;
          if (!wikidataQid) return null;
          // Match any feature with this QID (polity OR region/country — some historical
          // entities like Congress Poland live in the locations table). Prefer the
          // polity entry when both exist for the same QID (e.g. Joseon Q28179 has
          // both a region and a polity row; the polity row carries capital/sovereign).
          const features = geojsonRef.current.features;
          const polity = features.find(
            (p) => (p.properties as FeatureProperties).featureType === 'polity'
              && (p.properties as FeatureProperties).wikidataQid === wikidataQid,
          );
          if (polity) return polity;
          return features.find(
            (p) => (p.properties as FeatureProperties).wikidataQid === wikidataQid,
          ) ?? null;
        };

        const polityDuration = (f: maplibregl.MapGeoJSONFeature) => {
          const polity = resolvePolity(f);
          if (!polity) return Infinity;
          const p = polity.properties as FeatureProperties;
          return (p.yearEnd ?? 9999) - (p.yearStart ?? 0);
        };

        // Build sorted list of ALL unique OHM features at this point.
        // Matched polities come first (sorted by admin_level desc, then polity duration asc).
        // Unmatched (no polity, not suppressed) come after — clicking them opens the mapping modal.
        // Deduplicate: matched by polity id, unmatched by stripped name.
        const seenKeys = new Set<string>();
        type OhmEntry = { feature: maplibregl.MapGeoJSONFeature; polity: GeoJSON.Feature | null; strippedName: string };
        const allEntries: OhmEntry[] = allOhmFeatures
          .map((f) => ({
            feature: f,
            polity: resolvePolity(f),
            strippedName: stripName((f.properties?.name_en ?? f.properties?.name ?? '') as string),
          }))
          .filter(({ polity, strippedName }) => {
            // Deduplicate by polity id (matched) or stripped name (unmatched)
            const key = polity ? `polity:${(polity.properties as FeatureProperties).id}` : `name:${strippedName}`;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          })
          .sort((a, b) => {
            // Matched polities before unmatched
            if (!!a.polity !== !!b.polity) return a.polity ? -1 : 1;
            // Among matched: highest admin_level first, then shortest polity duration
            const levelDiff = Number(b.feature.properties?.admin_level ?? 0) - Number(a.feature.properties?.admin_level ?? 0);
            if (levelDiff !== 0) return levelDiff;
            return polityDuration(a.feature) - polityDuration(b.feature);
          });

        if (allEntries.length === 0) return;

        // Cycle through entries on repeated clicks at the same spot.
        const names = allEntries.map((e) => e.strippedName);
        let idx = 0;
        if (ohmStackRef.current?.names.length === names.length && ohmStackRef.current.names.every((n, i) => n === names[i])) {
          idx = (ohmStackRef.current.index + 1) % names.length;
        }
        ohmStackRef.current = { names, index: idx };

        const { feature: chosen, polity: chosenPolity, strippedName: chosenName } = allEntries[idx];

        if (chosenPolity) {
          const raw = { ...chosenPolity.properties } as Record<string, unknown>;
          for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
            if (typeof raw[key] === 'string') {
              try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
            }
          }
          // Attach OHM source context so InfoPanel can offer a direct-edit path back to OHM.
          raw._ohmOsmType = 'relation';
          raw._ohmOsmId = Math.abs(Number(chosen.properties?.osm_id ?? 0));
          onSelectRef.current(raw as unknown as FeatureProperties, { index: idx, total: allEntries.length });
        } else {
          // No local match. If OHM has a wikidata tag, open InfoPanel with a synthetic
          // feature that will live-fetch from Wikidata. Otherwise (no QID), fall back to
          // the mapping modal so the user can add a tag in OHM.
          const chosenOsmId = Math.abs(Number(chosen.properties?.osm_id));
          const chosenQid = chosenOsmId ? ohmQidMapRef.current[chosenOsmId] : undefined;
          if (chosenQid) {
            const stub = makeWikidataStub(chosenQid, chosenName, chosen.properties);
            stub._ohmOsmType = 'relation';
            stub._ohmOsmId = chosenOsmId;
            onSelectRef.current(stub, { index: idx, total: allEntries.length });
          } else {
            // ohm-fills features come from relation polygons (negative osm_id in the tile encoding).
            const rawId = Number(chosen.properties?.osm_id ?? 0);
            onOhmTerritoryClickRef.current?.(
              chosenName,
              null,
              parseOhmYear(chosen.properties?.start_date),
              parseOhmYear(chosen.properties?.end_date),
              'relation',
              Math.abs(rawId),
            );
          }
        }
        return;
      }

      // OHM centroid label click — mapped (white) labels open InfoPanel, unmapped (gray) open mapping modal
      if (top.layer.id === 'ohm-labels' || top.layer.id === 'ohm-labels-small') {
        const DATE_SUFFIX = /\s*\(\d{1,4}(?:\s*[-–]\s*(?:\d{1,4}|present))?\)\s*$/;
        const rawName = (top.properties?.name_en ?? top.properties?.name ?? '') as string;
        const stripped = rawName.replace(DATE_SUFFIX, '').trim();
        if (!stripped) return;
        // Match via osm_id → QID lookup (no `wikidata` tag in tiles).
        const osmId = Math.abs(Number(top.properties?.osm_id));
        const wikidataQid = osmId ? ohmQidMapRef.current[osmId] : undefined;
        const polityFeature = wikidataQid
          ? (geojsonRef.current.features.find(
              (p) => (p.properties as FeatureProperties).featureType === 'polity'
                && (p.properties as FeatureProperties).wikidataQid === wikidataQid,
            ) ?? geojsonRef.current.features.find(
              (p) => (p.properties as FeatureProperties).wikidataQid === wikidataQid,
            ))
          : undefined;
        if (polityFeature) {
          const raw = { ...polityFeature.properties } as Record<string, unknown>;
          for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
            if (typeof raw[key] === 'string') {
              try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
            }
          }
          // ohm-labels features come from nodes; track for direct-edit-back-to-OHM.
          raw._ohmOsmType = 'node';
          raw._ohmOsmId = Math.abs(Number(top.properties?.osm_id ?? 0));
          onSelectRef.current(raw as unknown as FeatureProperties, { index: 0, total: 1 });
        } else if (wikidataQid) {
          // No local feature, but OHM has a QID — open InfoPanel with a Wikidata-stub
          // feature; the panel will live-fetch the entity data.
          const stub = makeWikidataStub(wikidataQid, stripped, top.properties);
          stub._ohmOsmType = 'node';
          stub._ohmOsmId = Math.abs(Number(top.properties?.osm_id ?? 0));
          onSelectRef.current(stub, { index: 0, total: 1 });
        } else {
          // No QID at all — open the OHM mapping modal so the user can fix it on OHM.
          // ohm-labels features come from nodes (positive osm_id in the tile encoding).
          const rawId = Number(top.properties?.osm_id ?? 0);
          onOhmTerritoryClickRef.current?.(
            stripped,
            null,
            parseOhmYear(top.properties?.start_date),
            parseOhmYear(top.properties?.end_date),
            'node',
            Math.abs(rawId),
          );
        }
        return;
      }

      // Centroid label click — route same as OHM fill click
      if (top.layer.id === 'polity-centroid-labels') {
        const name = top.properties?.title as string | undefined;
        if (!name) return;
        const isMapped = top.properties?.mapped as boolean;
        // OHM source context carried through from rebuildColors so InfoPanel can offer
        // a direct-edit path back to the OHM relation/node.
        const ohmOsmId = top.properties?._ohmOsmId as number | null | undefined;
        const ohmOsmType = top.properties?._ohmOsmType as 'relation' | 'node' | null | undefined;
        if (isMapped) {
          // Find the polity feature and select it
          const polityFeature = geojsonRef.current.features.find(
            (f) => (f.properties as FeatureProperties).featureType === 'polity'
              && (f.properties as FeatureProperties).title?.toLowerCase() === name.toLowerCase(),
          );
          if (polityFeature) {
            const raw = { ...polityFeature.properties } as Record<string, unknown>;
            for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
              if (typeof raw[key] === 'string') {
                try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
              }
            }
            if (ohmOsmId && ohmOsmType) {
              raw._ohmOsmId = ohmOsmId;
              raw._ohmOsmType = ohmOsmType;
            }
            onSelectRef.current(raw as unknown as FeatureProperties, { index: 0, total: 1 });
          }
        } else {
          // Unmatched — open OHM mapping modal. Forward the OHM context so the modal
          // targets the right element when the user picks a polity to push to OHM.
          onOhmTerritoryClickRef.current?.(
            name,
            null,
            parseOhmYear(top.properties?.start_date),
            parseOhmYear(top.properties?.end_date),
            ohmOsmType ?? 'node',
            ohmOsmId ?? 0,
          );
        }
        return;
      }

      // If the top hit is an HB territory, resolve to the linked polity feature instead
      if (top.properties?.featureType === 'territory') {
        const polityId = top.properties?.polityId as string | null;
        if (!polityId) {
          // Unmatched territory — open the mapping assignment UI
          const hbName    = top.properties?.hbName     as string | undefined;
          const polygonId = top.properties?.polygonId  as string | undefined;
          const yearStart = top.properties?.yearStart   as number | undefined;
          const yearEnd   = top.properties?.yearEnd     as number | null | undefined;
          if (hbName && polygonId && yearStart != null) {
            onUnmatchedTerritoryRef.current?.(hbName, polygonId, yearStart, yearEnd ?? null);
          }
          return;
        }
        const polityFeature = geojsonRef.current.features.find(
          (f) => (f.properties as FeatureProperties).id === polityId,
        );
        if (!polityFeature) return;
        const raw = { ...polityFeature.properties } as Record<string, unknown>;
        for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
          if (typeof raw[key] === 'string') {
            try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
          }
        }
        onSelectRef.current(raw as unknown as FeatureProperties, { index: 0, total: 1 });
        return;
      }

      // Deduplicate by id — queryRenderedFeatures can return the same feature
      // from multiple layers (e.g. a war event appears in both circles-major and icons-war).
      // Also exclude territory features here — they are only handled via the early-return
      // branch above (when they're the top hit). Letting them into the stack cycling causes
      // handleSelectFeature to receive a territory with no yearStart → encodeDate(undefined) → NaN.
      const seen = new Set<string>();
      const unique = features.filter((f) => {
        if (f.properties?.featureType === 'territory') return false;
        const id = String(f.properties?.id ?? '');
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const ids = unique.map((f) => String(f.properties?.id ?? ''));
      let index = 0;
      if (stackRef.current?.ids.length === ids.length && stackRef.current.ids.every((id, i) => id === ids[i])) {
        index = (stackRef.current.index + 1) % ids.length;
      }
      stackRef.current = { ids, index };

      const raw = { ...unique[index].properties } as Record<string, unknown>;
      for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
        if (typeof raw[key] === 'string') {
          try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
        }
      }
      onSelectRef.current(raw as unknown as FeatureProperties, { index, total: ids.length });
    };

    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, []);

  const updateFilter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource('features') as GeoJSONSource | undefined;
    if (!source) return;

    const suppressed = suppressedPolityIdsRef.current;
    const hasTerritory = polityIdsWithTerritoryRef.current;
    const centroidIds = centroidPolityIdsRef.current;
    const currentYear = decodeDate(currentDateInt).year;

    // End of the current time "bucket": events starting anywhere within the current
    // year/month/day are all visible. e.g. in year mode (stepSize=10000), effectiveNow
    // covers the whole year so a Jul 14 event is visible when we're at "Jan 1789".
    const effectiveNow = currentDateInt + stepSize - 1;

    const visible = geojson.features.flatMap((f) => {
      // Null-geometry features (unlocated events) are Data Explorer-only — skip map rendering
      if (!f.geometry) return [];

      const p = f.properties as FeatureProperties;
      const isPolity   = p.featureType === 'polity';
      const isLocation = p.featureType === 'city' || p.featureType === 'region';

      // Polities use their own independent filter set
      if (isPolity) {
        // Require a start date always.
        // Null end date = "still active" — only valid for modern nation types (republic, kingdom).
        // Everything else (colony, empire, people, sultanate, etc.) must have an explicit end date.
        const STILL_ACTIVE_TYPES = new Set(['republic', 'kingdom']);
        if (p.yearStart == null) return [];
        if (p.yearEnd == null && !STILL_ACTIVE_TYPES.has(p.polityType ?? '')) return [];

        if (!showOtherPolities) return [];

        const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';

        // Snap in/out at year_start / year_end — no fade (same as locations)
        if (p.yearStart != null) {
          const locStart = encodeDate(p.yearStart, 1, 1);
          const locEnd   = p.yearEnd != null ? encodeDate(p.yearEnd, 12, 31) : null;
          const yearOk   = locStart <= effectiveNow && (locEnd == null || currentDateInt <= locEnd);
          if (!yearOk) return [];
        }

        // Hide if a more-specific (shorter-lived) co-capital polity is active now
        if (suppressed.has(p.id)) return [];

        // Hide modern nations before their hide_until_year threshold
        if (hiddenNations) {
          const threshold = hiddenNations.get(p.id);
          if (threshold !== undefined && currentYear < threshold) return [];
        }

        // Zoom threshold: sitelinks give a base zoom (more sitelinks = visible earlier),
        // then a per-type offset is added so noisier polity types appear later.
        const sl = p.sitelinksCount ?? null;
        const sitelinkZoom = sl === null ? 2 : sl >= 25 ? 1 : sl >= 10 ? 2 : sl >= 3 ? 4 : 6;
        const typeOffset   = POLITY_ZOOM_OFFSET[p.polityType ?? ''] ?? 3;
        const baseZoom     = sitelinkZoom + typeOffset;
        const isMapped = hasTerritory.has(p.id) || centroidIds.has(p.id);
        const isUnlinkedPrincipality = p.polityType === 'principality' && !isMapped;
        // Unmapped polities (stars) are pushed to higher zoom so they don't clutter the map.
        // Principalities get an even higher threshold.
        const unmappedMin = isUnlinkedPrincipality ? UNLINKED_PRINCIPALITY_MIN_ZOOM : 7;
        const _minZoom = !isMapped ? Math.max(baseZoom, unmappedMin) : baseZoom;

        const translatedTitle = (translationMap && p.wikidataQid) ? translationMap[p.wikidataQid] : undefined;
        const titleProps = translatedTitle ? { title: translatedTitle } : {};
        const _hasTerritory = hasTerritory.has(p.id) || centroidIds.has(p.id);
        // Mapped polities: star only at high zoom, with capital name label
        const _starMinZoom = isMapped ? 7 : _minZoom;
        const _capitalLabel = isMapped && p.capitalName ? p.capitalName : null;
        return [{ ...f, properties: { ...f.properties, ...titleProps, _opacity: 1.0, _labelOpacity: 1.0, _color, _minZoom, _hasTerritory, _starMinZoom, _capitalLabel } }];
      }

      const catOk = p.categories.some((c) => activeCategories.has(c));
      if (!catOk) return [];

      // Locations with no founding date: always visible
      if (p.yearStart == null) {
        if (!isLocation) return [];
        const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';
        return [{ ...f, properties: { ...f.properties, _opacity: 1.0, _color } }];
      }

      let yearOk: boolean;
      if (isLocation) {
        const locStart = encodeDate(p.yearStart, 1, 1);
        const locEnd   = p.yearEnd != null ? encodeDate(p.yearEnd, 12, 31) : null;
        yearOk = locStart <= effectiveNow && (locEnd == null || currentDateInt <= locEnd);
      } else {
        const [startInt, endInt] = eventDateRange(
          p.yearStart, p.monthStart, p.dayStart,
          p.yearEnd,   p.monthEnd,   p.dayEnd,
        );
        const lingerWindow = showRecentEvents ? Math.min(LINGER_STEPS * stepSize, LINGER_MAX) : 0;
        yearOk = startInt <= effectiveNow && currentDateInt <= endInt + lingerWindow;
      }

      if (!yearOk) return [];

      // Major event filter: hide events that aren't part of the selected parent event
      if (majorEventFilter && !isLocation && p.featureType === 'event') {
        if (!(p.partOf ?? []).includes(majorEventFilter)) return [];
      }

      let opacity = 1.0;
      if (!isLocation) {
        const [, endInt] = eventDateRange(
          p.yearStart, p.monthStart, p.dayStart,
          p.yearEnd,   p.monthEnd,   p.dayEnd,
        );
        if (currentDateInt > endInt) {
          opacity = 0.5;
        }
      }

      const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';
      const extraProps: Record<string, unknown> = {
        _opacity: opacity,
        _labelOpacity: 1.0,
        _color,
      };

      if (!isLocation) {
        // Sitelinks count drives both zoom threshold and pin size.
        // Higher sitelinks = more globally significant = visible earlier + bigger pin.
        const sl = p.sitelinksCount ?? null;
        extraProps._minZoom = sl === null ? 4 : sl >= 80 ? 1 : sl >= 40 ? 2 : sl >= 20 ? 3 : sl >= 10 ? 4 : sl >= 3 ? 5 : 6;
        extraProps._radius  = sl === null ? 7 : sl >= 25 ? 12 : sl >= 10 ? 9 : sl >= 3 ? 7 : 5;
        extraProps._icon    = (p.primaryCategory in CATEGORY_SVGS) ? catIconName(p.primaryCategory as Category) : 'marker';
      }

      return [{ ...f, properties: { ...f.properties, ...extraProps } }];
    });

    // Apply translated titles to events + locations on the way out. Polities
    // already have `title` overwritten above (line ~1794), but events and
    // locations don't go through that branch — so the map labels stay
    // English until we patch them here. translationMap[qid] is the label in
    // the user's selected language; we overwrite `title` so the existing
    // `['get', 'title']` text-field expression picks it up without touching
    // every label layer.
    const hasTranslations = translationMap && Object.keys(translationMap).length > 0;
    const localized = hasTranslations
      ? visible.map((f) => {
          const p = f.properties as FeatureProperties;
          if (p.featureType === 'polity') return f;  // already handled above
          const qid = p.wikidataQid;
          const t = qid ? translationMap[qid] : undefined;
          if (!t) return f;
          return { ...f, properties: { ...f.properties, title: t } };
        })
      : visible;

    source.setData({ type: 'FeatureCollection', features: localized });

    // Territory fill layer — time-filter by yearStart/yearEnd (HB mode only)
    const terrSource = map.getSource('territories') as GeoJSONSource | undefined;
    if (terrSource && territorySourceRef.current !== 'ohm') {
      // Build polityId (UUID) → wikidataQid lookup for territory label translation
      const polityIdToQid: Record<string, string> = {};
      if (translationMap && Object.keys(translationMap).length > 0) {
        for (const f of geojson.features) {
          const p = f.properties as FeatureProperties;
          if (p.featureType === 'polity' && p.id && p.wikidataQid) {
            polityIdToQid[p.id] = p.wikidataQid;
          }
        }
      }

      const allTerritories = territoriesGeojsonRef.current?.features ?? [];
      const visibleTerritories = allTerritories.flatMap((f) => {
        const p = f.properties as {
          yearStart: number;
          yearEnd: number | null;
          polityType: string | null;
          polityId: string | null;
        };
        if (p.yearStart > currentYear) return [];
        if (p.yearEnd !== null && currentYear > p.yearEnd) return [];
        if (!showBorders) return [];
        // If polity is a hidden modern nation, render territory as unlinked (gray, no name)
        if (p.polityId && hiddenNations?.has(p.polityId)) {
          return [{ ...f, properties: { ...f.properties, polityId: null, polityName: null, politySlug: null, polityType: null } }];
        }
        // Apply translated polity name if available
        const qid = p.polityId ? polityIdToQid[p.polityId] : null;
        const translatedName = (qid && translationMap) ? translationMap[qid] : null;
        if (translatedName) {
          return [{ ...f, properties: { ...f.properties, polityName: translatedName } }];
        }
        // Note: suppressedPolityIds is intentionally NOT applied to territory polygons.
        // Capital-conflict suppression is only for polity marker dots — territory shapes
        // have explicit geographic bounds and should always render within their time interval.
        return [f];
      });
      terrSource.setData({ type: 'FeatureCollection', features: visibleTerritories });

      const labelSource = map.getSource('territory-labels') as GeoJSONSource | undefined;
      if (labelSource) {
        labelSource.setData({ type: 'FeatureCollection', features: buildLabelPoints(visibleTerritories) });
      }

      // Build centroid labels for ALL territories — mapped (white) and unmapped (gray).
      // One label per territory group: mapped group by polityId, unmapped group by hbName.
      const centroidSrc = map.getSource('polity-centroid-src') as GeoJSONSource | undefined;
      if (centroidSrc) {
        const byKey: Record<string, { area: number; centroid: [number, number]; name: string; mapped: boolean; polygonId?: string; hbName?: string; yearStart?: number; yearEnd?: number | null }> = {};
        for (const f of visibleTerritories) {
          const props = f.properties as Record<string, unknown>;
          const pid = props.polityId as string | null;
          const name = (pid ? (props.polityName ?? props.hbName) : props.hbName) as string ?? '';
          if (!name) continue;
          const key = pid ?? `hb::${name}::${props.polygonId ?? ''}`;
          const geom = f.geometry;
          if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
          const rings = geom.type === 'Polygon'
            ? [(geom as GeoJSON.Polygon).coordinates]
            : (geom as GeoJSON.MultiPolygon).coordinates;
          for (const r of rings) {
            if (!r[0]?.length) continue;
            const a = ringArea(r[0]);
            if (!byKey[key] || a > byKey[key].area) {
              byKey[key] = {
                area: a, centroid: ringCentroid(r[0]), name, mapped: !!pid,
                polygonId: props.polygonId as string | undefined,
                hbName: props.hbName as string | undefined,
                yearStart: props.yearStart as number | undefined,
                yearEnd: props.yearEnd as number | null | undefined,
              };
            }
          }
        }
        const centroidFeatures: GeoJSON.Feature[] = Object.entries(byKey).map(([key, v]) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: v.centroid },
          properties: {
            title: v.name,
            mapped: v.mapped,
            polityId: v.mapped ? key : null,
            polygonId: v.polygonId,
            hbName: v.hbName,
            yearStart: v.yearStart,
            yearEnd: v.yearEnd,
            featureType: 'territory',
          },
        }));
        centroidSrc.setData({ type: 'FeatureCollection', features: centroidFeatures });
      }
    }
  }, [geojson, territoriesGeojson, currentDateInt, stepSize, activeCategories, showBorders, showOtherPolities, hiddenNations, majorEventFilter, translationMap, showRecentEvents]);

  // Keep the ref current so the map.on('load') callback always invokes the latest version
  updateFilterRef.current = updateFilter;

  useEffect(() => {
    updateFilter();
  }, [updateFilter]);

  useEffect(() => {
    if (!zoomRequest) return;
    const map = mapRef.current;
    if (!map) return;

    const target = geojson.features.find(
      (f) => (f.properties as FeatureProperties).slug === zoomRequest.feature.slug,
    );

    const doFly = () => {
      if (target?.geometry?.type === 'Point') {
        const [lon, lat] = (target.geometry as GeoJSON.Point).coordinates;
        map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 6), duration: 800 });
      } else if (zoomRequest.center) {
        map.flyTo({ center: zoomRequest.center, zoom: Math.max(map.getZoom(), 6), duration: 800 });
      }
      onSelectRef.current(zoomRequest.feature, { index: 0, total: 1 });
    };

    if (map.isStyleLoaded()) doFly();
    else map.once('load', doFly);
  }, [zoomRequest, geojson]);

  useEffect(() => {
    if (!fitBoundsRequest) return;
    const map = mapRef.current;
    if (!map) return;
    const [west, south, east, north] = fitBoundsRequest.bbox;
    const doFit = () => {
      map.fitBounds([[west, south], [east, north]], {
        padding: { top: 80, bottom: 140, left: 80, right: 420 },
        maxZoom: 8,
        duration: 900,
      });
    };
    if (map.isStyleLoaded()) doFit();
    else map.once('load', doFit);
  }, [fitBoundsRequest]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* × unlink button — appears next to a hovered matched territory label (HB mode) */}
      {hoveredLabel && (
        <button
          onMouseEnter={() => {
            if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
          }}
          onMouseLeave={() => setHoveredLabel(null)}
          onClick={() => {
            onUnlinkPolygonRef.current?.(hoveredLabel.polygonId);
            setHoveredLabel(null);
          }}
          title="Unlink territory from polity"
          style={{
            position: 'absolute',
            left: hoveredLabel.x + 6,
            top: hoveredLabel.y - 10,
            zIndex: 20,
            background: 'rgba(30,30,30,0.82)',
            color: '#eeeeee',
            border: '1px solid rgba(245,200,66,0.5)',
            borderRadius: '50%',
            width: 18,
            height: 18,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      )}

      {/* Modern border layer toggle — sits to the left of the NavigationControl */}
      <style>{`
        .oh-borders-btn .oh-tooltip {
          display: none;
          position: absolute;
          top: 50%;
          right: 36px;
          transform: translateY(-50%);
          background: rgba(20,20,20,0.9);
          color: #fff;
          font-size: 11px;
          font-weight: 500;
          white-space: nowrap;
          padding: 4px 8px;
          border-radius: 4px;
          pointer-events: none;
        }
        .oh-borders-btn:hover .oh-tooltip { display: block; }
      `}</style>
      <div
        className="oh-borders-btn"
        style={{ position: 'absolute', top: 10, right: 50, zIndex: 10 }}
      >
        <button
          onClick={() => setShowModernBorders((v) => !v)}
          style={{
            width: 29,
            height: 29,
            background: showModernBorders ? '#3366cc' : '#ffffff',
            border: '1px solid rgba(0,0,0,0.3)',
            borderRadius: 4,
            boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon
              points="7.5,1.5 13.5,5.5 13.5,9.5 7.5,13.5 1.5,9.5 1.5,5.5"
              fill="none"
              stroke={showModernBorders ? '#ffffff' : '#54595d'}
              strokeWidth="1.4"
              strokeDasharray="2.2 1.8"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="oh-tooltip">{showModernBorders ? 'Hide Modern Borders' : 'Show Modern Borders'}</span>
      </div>
    </div>
  );
}
