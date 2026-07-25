import { Link, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatSom, localized } from '@bozorlar/api-client';
import type { ProductResponse } from '@bozorlar/contracts';
import { Locale } from '@bozorlar/types';
import { useApi } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * A stall's goods, with today's price on a slate.
 *
 * The chalk board carries across from the web: at a bazaar the price is written and rewritten
 * by hand, and a dropped price keeps the old figure struck through — the same comparison the
 * price-drop notification makes, so the alert and the screen agree.
 */
export default function ShopScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const api = useApi();

  const shop = useQuery({
    queryKey: ['shop', slug],
    queryFn: () => api.shops.get(slug).then((response) => response.data),
  });

  const products = useQuery({
    queryKey: ['shop-products', shop.data?.id],
    queryFn: () => api.products.list({ shopId: shop.data?.id ?? '', limit: 100 }).then((r) => r.data),
    enabled: Boolean(shop.data?.id),
  });

  if (shop.isPending || products.isPending) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (shop.isError || products.isError || !products.data) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Ochib bo'lmadi.</Text>
      </View>
    );
  }

  // Purchasable first; sold-out stays listed so it can be followed for a restock.
  const sorted = [...products.data].sort(
    (a, b) => Number(b.isPurchasable) - Number(a.isPurchasable),
  );

  return (
    <FlatList
      data={sorted}
      keyExtractor={(product) => product.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={styles.muted}>Bu do'konda mahsulot yo'q.</Text>}
      renderItem={({ item }) => <ProductRow product={item} />}
    />
  );
}

function ProductRow({ product }: { product: ProductResponse }) {
  const unit = product.availableQty.unit;
  const dropped = product.oldPrice != null;

  return (
    <Link href={{ pathname: '/product/[slug]', params: { slug: product.slug } }} asChild>
      <Pressable style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {localized(product.name, Locale.UZ_LATN)}
        </Text>
        <Text style={product.isPurchasable ? styles.meta : styles.gone}>
          {product.isPurchasable
            ? `Qoldiq: ${product.availableQty.value} ${unit}`
            : 'Bugun tugagan'}
        </Text>
      </View>

      <View style={[styles.board, !product.isPurchasable && styles.boardFaded]}>
        {dropped && product.oldPrice ? (
          <Text style={styles.oldPrice}>{formatSom(product.oldPrice.amount)}</Text>
        ) : null}
        <Text style={styles.price}>{formatSom(product.price.amount)}</Text>
        <Text style={styles.unit}>so'm/{unit}</Text>
      </View>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },
  rowText: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', color: theme.ink },
  meta: { marginTop: 4, fontSize: 12, color: theme.muted },
  gone: { marginTop: 4, fontSize: 12, color: theme.pomegranate },
  board: { backgroundColor: theme.slate, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'flex-end' },
  boardFaded: { opacity: 0.55 },
  oldPrice: { fontSize: 11, color: theme.chalkDim, textDecorationLine: 'line-through' },
  price: { fontSize: 18, fontWeight: '700', color: theme.chalk },
  unit: { fontSize: 10, color: theme.chalkDim },
  muted: { color: theme.muted, textAlign: 'center', marginTop: 32 },
  error: { color: theme.pomegranate },
});
