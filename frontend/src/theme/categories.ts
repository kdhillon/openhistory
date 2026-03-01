import type { Category } from '../types';

export const CATEGORY_COLORS: Record<Category, string> = {
  battle: '#DB4436',
  politics: '#4285F4',
  founding: '#0F9D58',
  religion: '#F4B400',
  natural_disaster: '#FF6D00',
  city: '#9C27B0',
  unknown: '#9E9E9E',
};

export const CATEGORY_LABELS: Record<Category, string> = {
  battle: 'Battle',
  politics: 'Politics',
  founding: 'Founding',
  religion: 'Religion',
  natural_disaster: 'Natural Disaster',
  city: 'City',
  unknown: 'Other',
};

export const ALL_CATEGORIES: Category[] = [
  'battle',
  'politics',
  'founding',
  'religion',
  'natural_disaster',
  'city',
];

export function getCategoryColor(category: Category): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.unknown;
}
