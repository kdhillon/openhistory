export type LocationLevel = 'point' | 'city' | 'country' | 'region';

export type Category =
  | 'battle'
  | 'politics'
  | 'founding'
  | 'religion'
  | 'natural_disaster'
  | 'city'
  | 'unknown';

export interface FeatureProperties {
  featureType: 'event' | 'city';
  id: string;
  title: string;
  wikipediaTitle: string;
  wikipediaSummary: string;
  wikipediaUrl: string;
  yearStart: number | null;
  yearEnd: number | null;
  dateIsFuzzy: boolean;
  dateRangeMin: number | null;
  dateRangeMax: number | null;
  locationLevel?: LocationLevel;
  locationName: string;
  categories: Category[];
  primaryCategory: Category;
  yearDisplay: string;
}

export interface TimelineState {
  currentYear: number;
  stepSize: number;
  isPlaying: boolean;
  playbackSpeed: number; // years per second
}

export const YEAR_MIN = -500;
export const YEAR_MAX = 500;
