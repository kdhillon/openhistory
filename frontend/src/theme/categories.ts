import type { Category } from '../types';

export const CATEGORY_COLORS: Record<Category, string> = {
  battle:        '#EF5350',  // bright red
  war:           '#7B0000',  // dark maroon
  politics:      '#9C27B0',  // purple
  religion:      '#F4B400',  // amber
  disaster:      '#FF6D00',  // orange
  exploration:   '#009688',  // teal
  science:       '#3F51B5',  // indigo
  culture:       '#2E7D32',  // green
  city:          '#4285F4',  // blue
  region:        '#00897B',  // dark teal
  country:       '#546E7A',  // blue-grey
  // Polity subtypes
  empire:        '#8B0000',  // deep crimson
  kingdom:       '#1A237E',  // midnight blue
  principality:  '#4E342E',  // dark brown (sub-sovereign states)
  republic:      '#1B5E20',  // dark green
  confederation: '#4A148C',  // deep purple
  sultanate:     '#BF360C',  // burnt sienna
  papacy:        '#F9A825',  // gold
  other:         '#607D8B',  // blue-grey (unclassified polities)
  unknown:       '#9E9E9E',  // grey
};

export const CATEGORY_LABELS: Record<Category, string> = {
  battle:        'Battle',
  war:           'War',
  politics:      'Politics',
  religion:      'Religion',
  disaster:      'Disaster',
  exploration:   'Exploration',
  science:       'Science',
  culture:       'Culture',
  city:          'City',
  region:        'Region',
  country:       'Country',
  // Polity subtypes
  empire:        'Empire',
  kingdom:       'Kingdom',
  principality:  'Principality',
  republic:      'Republic',
  confederation: 'Confederation',
  sultanate:     'Sultanate',
  papacy:        'Papacy',
  other:         'Other',
  unknown:       'Unknown',
};

export const EVENT_CATEGORIES: Category[] = [
  'battle',
  'war',
  'politics',
  'religion',
  'disaster',
  'exploration',
  'science',
  'culture',
];

export const LOCATION_CATEGORIES: Category[] = [
  'city',
  'region',
  'country',
];

export const POLITY_CATEGORIES: Category[] = [
  'empire',
  'kingdom',
  'principality',
  'republic',
  'confederation',
  'sultanate',
  'papacy',
  'other',
];

export const ALL_CATEGORIES: Category[] = [
  ...EVENT_CATEGORIES,
  ...LOCATION_CATEGORIES,
];

export function getCategoryColor(category: Category): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.unknown;
}

/** Maki sprite icon name for each event category. Used on the map and in tag chips. */
export const CATEGORY_ICON_NAMES: Partial<Record<Category, string>> = {
  battle:      'danger',
  war:         'danger',
  politics:    'town_hall',
  religion:    'place_of_worship',
  disaster:    'volcano',
  exploration: 'harbor',
  science:     'rocket',
  culture:     'park',
};

/** CDN URL for a Maki SVG icon (converts sprite underscore names to hyphenated CDN names). */
export function makiIconUrl(spriteName: string): string {
  return `https://raw.githubusercontent.com/mapbox/maki/main/icons/${spriteName.replace(/_/g, '-')}.svg`;
}
