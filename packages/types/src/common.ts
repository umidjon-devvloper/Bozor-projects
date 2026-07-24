import type { Locale } from './enums.js';

/** Branded ids. Prevents passing a shopId where an orderId is expected (CONVENTIONS.md). */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type ShopId = Brand<string, 'ShopId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type MarketId = Brand<string, 'MarketId'>;

export const asId = <T extends Brand<string, string>>(value: string): T => value as T;

/** ADR-0020: localized content is an object, never a bare string. `uz` is always required. */
export interface LocalizedText {
  uz: string;
  uzCyrl?: string;
  ru?: string;
  en?: string;
}

const FALLBACK_ORDER: Record<Locale, ReadonlyArray<keyof LocalizedText>> = {
  'uz-Latn': ['uz', 'uzCyrl', 'ru', 'en'],
  'uz-Cyrl': ['uzCyrl', 'uz', 'ru', 'en'],
  ru: ['ru', 'uzCyrl', 'uz', 'en'],
  en: ['en', 'uz', 'ru', 'uzCyrl'],
};

export function resolveLocalized(text: LocalizedText, locale: Locale): string {
  for (const key of FALLBACK_ORDER[locale]) {
    const value = text[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return text.uz;
}

/** Wire representation of money and quantity: integer minor units as strings (ADR-0028). */
export interface MoneyDTO {
  amount: string;
  currency: 'UZS';
}
export interface QuantityDTO {
  value: string;
  unit: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** GeoJSON stores longitude first. Reversing it is the classic geo bug. */
export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

export interface LatLng {
  lat: number;
  lng: number;
}

export const toGeoPoint = ({ lat, lng }: LatLng): GeoPoint => ({
  type: 'Point',
  coordinates: [lng, lat],
});

export const fromGeoPoint = (point: GeoPoint): LatLng => ({
  lat: point.coordinates[1],
  lng: point.coordinates[0],
});

/** 0 = Sunday, matching JavaScript's Date.getUTCDay(). */

export interface HolidayOverride {
  date: string;
  isClosed: boolean;
  opensAt?: string;
  closesAt?: string;
}
