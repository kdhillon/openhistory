/**
 * export-geojson.ts
 *
 * Queries the local Postgres database and writes a GeoJSON FeatureCollection
 * to ../frontend/src/data/seed.geojson, ready for the frontend to consume.
 *
 * Usage: npm run export
 */

import { Client } from 'pg';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../frontend/src/data/seed.geojson');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://ourstory:ourstory@localhost:5432/ourstory';

interface EventRow {
  id: string;
  title: string;
  wikipedia_title: string;
  wikipedia_summary: string | null;
  wikipedia_url: string;
  year_start: number;
  year_end: number | null;
  date_is_fuzzy: boolean;
  date_range_min: number | null;
  date_range_max: number | null;
  location_level: 'point' | 'city' | 'country' | 'region';
  lng: number;
  lat: number;
  location_name: string;
  categories: string[];
}

interface CityRow {
  id: string;
  name: string;
  wikipedia_title: string;
  wikipedia_summary: string | null;
  wikipedia_url: string;
  lng: number;
  lat: number;
  founded_year: number | null;
  founded_is_fuzzy: boolean;
  founded_range_min: number | null;
  founded_range_max: number | null;
  dissolved_year: number | null;
}

function displayYear(year: number): string {
  if (year === 0) return 'Year 0';
  if (year < 0) return `${Math.abs(year)} BCE`;
  return `${year} CE`;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database');

  // -- Events (join to cities for coordinates when not a point event) --
  const eventsResult = await client.query<EventRow>(`
    SELECT
      e.id,
      e.title,
      e.wikipedia_title,
      e.wikipedia_summary,
      e.wikipedia_url,
      e.year_start,
      e.year_end,
      e.date_is_fuzzy,
      e.date_range_min,
      e.date_range_max,
      e.location_level,
      CASE WHEN e.location_level = 'point' THEN e.lng ELSE c.lng END AS lng,
      CASE WHEN e.location_level = 'point' THEN e.lat ELSE c.lat END AS lat,
      e.location_name,
      e.categories
    FROM events e
    LEFT JOIN cities c ON e.location_id = c.id
    ORDER BY e.year_start
  `);

  // -- Cities --
  const citiesResult = await client.query<CityRow>(`
    SELECT * FROM cities ORDER BY founded_year NULLS LAST
  `);

  await client.end();

  const features: object[] = [];

  // Event features
  for (const row of eventsResult.rows) {
    if (row.lng == null || row.lat == null) {
      console.warn(`Skipping event "${row.title}" — no resolvable coordinates`);
      continue;
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Number(row.lng), Number(row.lat)],
      },
      properties: {
        featureType: 'event',
        id: row.id,
        title: row.title,
        wikipediaTitle: row.wikipedia_title,
        wikipediaSummary: row.wikipedia_summary ?? '',
        wikipediaUrl: row.wikipedia_url,
        yearStart: row.year_start,
        yearEnd: row.year_end,
        dateIsFuzzy: row.date_is_fuzzy,
        dateRangeMin: row.date_range_min,
        dateRangeMax: row.date_range_max,
        locationLevel: row.location_level,
        locationName: row.location_name,
        categories: row.categories,
        primaryCategory: row.categories[0] ?? 'unknown',
        yearDisplay: displayYear(row.year_start),
      },
    });
  }

  // City features
  for (const row of citiesResult.rows) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [Number(row.lng), Number(row.lat)],
      },
      properties: {
        featureType: 'city',
        id: row.id,
        title: row.name,
        wikipediaTitle: row.wikipedia_title,
        wikipediaSummary: row.wikipedia_summary ?? '',
        wikipediaUrl: row.wikipedia_url,
        yearStart: row.founded_year,
        yearEnd: row.dissolved_year,
        dateIsFuzzy: row.founded_is_fuzzy,
        dateRangeMin: row.founded_range_min,
        dateRangeMax: row.founded_range_max,
        locationName: row.name,
        categories: ['city'],
        primaryCategory: 'city',
        yearDisplay: row.founded_year != null ? displayYear(row.founded_year) : 'Unknown',
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    features,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 2));
  console.log(`Wrote ${features.length} features to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
