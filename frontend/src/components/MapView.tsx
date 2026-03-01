import { useEffect, useRef, useCallback } from 'react';
import maplibregl, { Map, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';

interface Props {
  geojson: GeoJSON.FeatureCollection;
  currentYear: number;
  activeCategories: Set<Category>;
  onSelectFeature: (props: FeatureProperties) => void;
}

// Build MapLibre 'match' expression: ['match', ['get', 'primaryCategory'], cat1, color1, ..., defaultColor]
function buildColorExpression(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ['match', ['get', 'primaryCategory']];
  for (const [cat, color] of Object.entries(CATEGORY_COLORS)) {
    expr.push(cat, color);
  }
  expr.push('#9E9E9E'); // fallback
  return expr as maplibregl.ExpressionSpecification;
}

export function MapView({ geojson, currentYear, activeCategories, onSelectFeature }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [20, 35],
      zoom: 3,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('features', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'feature-circles',
        type: 'circle',
        source: 'features',
        paint: {
          'circle-color': buildColorExpression(),
          'circle-radius': [
            'case',
            ['==', ['get', 'featureType'], 'city'], 7,
            6,
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': [
            'case',
            ['boolean', ['get', 'dateIsFuzzy'], false], 0.6,
            1,
          ],
        },
      });

      // Hover cursor
      map.on('mouseenter', 'feature-circles', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'feature-circles', () => {
        map.getCanvas().style.cursor = '';
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Click handler — kept up to date via ref pattern
  const onSelectRef = useRef(onSelectFeature);
  onSelectRef.current = onSelectFeature;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      onSelectRef.current(feature.properties as FeatureProperties);
    };

    map.on('click', 'feature-circles', onClick);
    return () => { map.off('click', 'feature-circles', onClick); };
  }, []);

  // Update visible features when year or categories change
  const updateFilter = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const source = map.getSource('features') as GeoJSONSource | undefined;
    if (!source) return;

    const visible = geojson.features.filter((f) => {
      const p = f.properties as FeatureProperties;
      const yearOk = p.yearStart != null && p.yearStart <= currentYear;
      const catOk = p.categories.some((c) => activeCategories.has(c));
      return yearOk && catOk;
    });

    source.setData({ type: 'FeatureCollection', features: visible });
  }, [geojson, currentYear, activeCategories]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) {
      updateFilter();
    } else {
      map.once('load', updateFilter);
    }
  }, [updateFilter]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
