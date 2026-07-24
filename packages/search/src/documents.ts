import type mongoose from 'mongoose';
import { resolveLocalized, type LocalizedText } from '@bozorlar/types';
import { normalizeForSearch, searchVariants } from './normalize.js';

/**
 * Maps a stored product or shop into its indexed form.
 *
 * The index is denormalised on purpose: a search result shows the shop and market name, and
 * fetching those per hit would make a fast query slow. The cost is that a shop rename has to
 * fan out to its products, which the reindex job and the shop-updated handler both do.
 */
export interface ProductDocument {
  id: string;
  name: string;
  nameNormalized: string;
  description?: string;
  descriptionNormalized?: string;
  tags: string[];
  shopId: string;
  shopName: string;
  shopNameNormalized: string;
  marketId: string;
  marketName?: string;
  districtId: string;
  regionId: string;
  categoryId: string;
  categoryPath: string[];
  categoryName?: string;
  unit: string;
  /**
   * Int64 tiyin, exactly as in MongoDB — never a major-unit float, which is what would let
   * search disagree with the catalogue about a price.
   *
   * Typed `number` in deliberate departure from ADR-0004, because Typesense cannot sort or
   * range-filter a string field and the index schema declares this as `int64`. The value stays
   * an exact integer: tiyin amounts are many orders of magnitude below 2^53, where a JS number
   * stops being exact. Every conversion in and out goes through `Money`.
   */
  // eslint-disable-next-line no-restricted-syntax -- see above; ADR-0004 exception for the index
  price: number;
  inStock: boolean;
  rating: number;
  ratingCount: number;
  salesCount: number;
  imageKey?: string;
  location?: [number, number];
  createdAt: number;
  popularity: number;
}

export interface ShopDocument {
  id: string;
  name: string;
  nameNormalized: string;
  description?: string;
  marketId: string;
  marketName?: string;
  marketNameNormalized?: string;
  districtId: string;
  regionId: string;
  sectionCode?: string;
  stallNo?: string;
  rating: number;
  ratingCount: number;
  productCount: number;
  salesCount: number;
  logoKey?: string;
  location?: [number, number];
  popularity: number;
}

const allText = (text: LocalizedText | null | undefined): Array<string | undefined> =>
  text ? [text.uz, text.uzCyrl, text.ru, text.en] : [];

/**
 * A single ranking scalar.
 *
 * Typesense needs one numeric default sort, and "how much has this actually sold, damped by
 * how well it is rated" is a better tie-break than recency: a bazaar shopper wants the stall
 * that sells tomatoes all day, not the one that listed them most recently.
 */
function popularityOf(input: { salesCount: number; rating: number; ratingCount: number }): number {
  const ratingWeight = input.ratingCount > 0 ? input.rating / 100 : 3;
  return Math.round(input.salesCount * ratingWeight);
}

export interface ProductSource {
  _id: mongoose.Types.ObjectId;
  name: LocalizedText;
  description: LocalizedText | null;
  tags: string[];
  shopId: mongoose.Types.ObjectId;
  marketId: mongoose.Types.ObjectId;
  districtId: mongoose.Types.ObjectId;
  regionId: mongoose.Types.ObjectId;
  categoryId: mongoose.Types.ObjectId;
  categoryPath: mongoose.Types.ObjectId[];
  unit: string;
  price: mongoose.mongo.Long;
  stockQtyMilli: mongoose.mongo.Long;
  reservedQtyMilli: mongoose.mongo.Long;
  minOrderQtyMilli: mongoose.mongo.Long;
  ratingAvg: number;
  ratingCount: number;
  salesCount: number;
  images: Array<{ mediaKey: string }>;
  createdAt: Date;
}

export interface ShopContext {
  name: LocalizedText;
  marketName?: LocalizedText | undefined;
  location?: [number, number] | undefined;
}

export function toProductDocument(
  product: ProductSource,
  shop: ShopContext,
  categoryName?: LocalizedText,
): ProductDocument {
  const nameVariants = searchVariants(allText(product.name));
  const descriptionVariants = searchVariants(allText(product.description));
  const shopVariants = searchVariants(allText(shop.name));

  const available = BigInt(product.stockQtyMilli.toString()) - BigInt(product.reservedQtyMilli.toString());
  const document: ProductDocument = {
    id: product._id.toString(),
    name: nameVariants.original,
    nameNormalized: nameVariants.normalized,
    tags: product.tags.map((tag) => normalizeForSearch(tag)).filter(Boolean),
    shopId: product.shopId.toString(),
    shopName: shopVariants.original,
    shopNameNormalized: shopVariants.normalized,
    marketId: product.marketId.toString(),
    districtId: product.districtId.toString(),
    regionId: product.regionId.toString(),
    categoryId: product.categoryId.toString(),
    categoryPath: product.categoryPath.map((id) => id.toString()),
    unit: product.unit,
    // Minor units, as an integer, exactly as MongoDB holds it — a float here would let the
    // index disagree with the catalogue about a price.
    price: Number(product.price.toString()),
    inStock: available >= BigInt(product.minOrderQtyMilli.toString()),
    rating: product.ratingAvg,
    ratingCount: product.ratingCount,
    salesCount: product.salesCount,
    createdAt: product.createdAt.getTime(),
    popularity: popularityOf({
      salesCount: product.salesCount,
      rating: product.ratingAvg,
      ratingCount: product.ratingCount,
    }),
  };

  if (descriptionVariants.original) {
    document.description = descriptionVariants.original;
    document.descriptionNormalized = descriptionVariants.normalized;
  }
  if (shop.marketName) document.marketName = resolveLocalized(shop.marketName, 'uz-Latn');
  if (categoryName) document.categoryName = resolveLocalized(categoryName, 'uz-Latn');
  const firstImage = product.images[0]?.mediaKey;
  if (firstImage) document.imageKey = firstImage;
  if (shop.location) document.location = shop.location;

  return document;
}

export interface ShopSource {
  _id: mongoose.Types.ObjectId;
  name: LocalizedText;
  description: LocalizedText | null;
  marketId: mongoose.Types.ObjectId;
  districtId: mongoose.Types.ObjectId;
  regionId: mongoose.Types.ObjectId;
  sectionCode: string | null;
  stallNo: string | null;
  ratingAvg: number;
  ratingCount: number;
  productCount: number;
  salesCount: number;
  logo: { mediaKey: string } | null;
  location: { coordinates: [number, number] } | null;
}

export function toShopDocument(
  shop: ShopSource,
  marketName?: LocalizedText,
  marketLocation?: [number, number],
): ShopDocument {
  const nameVariants = searchVariants(allText(shop.name));
  const marketVariants = searchVariants(allText(marketName));

  const document: ShopDocument = {
    id: shop._id.toString(),
    name: nameVariants.original,
    nameNormalized: nameVariants.normalized,
    marketId: shop.marketId.toString(),
    districtId: shop.districtId.toString(),
    regionId: shop.regionId.toString(),
    rating: shop.ratingAvg,
    ratingCount: shop.ratingCount,
    productCount: shop.productCount,
    salesCount: shop.salesCount,
    popularity: popularityOf({
      salesCount: shop.salesCount,
      rating: shop.ratingAvg,
      ratingCount: shop.ratingCount,
    }),
  };

  const description = searchVariants(allText(shop.description));
  if (description.original) document.description = description.original;
  if (marketVariants.original) {
    document.marketName = marketVariants.original;
    document.marketNameNormalized = marketVariants.normalized;
  }
  if (shop.sectionCode) document.sectionCode = shop.sectionCode;
  if (shop.stallNo) document.stallNo = shop.stallNo;
  if (shop.logo?.mediaKey) document.logoKey = shop.logo.mediaKey;

  // GeoJSON is [lng, lat]; Typesense geopoints are [lat, lng]. Getting this backwards puts
  // every stall in the wrong hemisphere, silently.
  const point = shop.location?.coordinates ?? marketLocation;
  if (point) document.location = [point[1], point[0]];

  return document;
}
