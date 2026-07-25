import { Link, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { localized } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import { useApi } from '@bozorlar/session';
import { theme } from '@/theme';

/** A bazaar's stalls, open ones first — shut stalls stay listed so they can still be found. */
export default function MarketScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const api = useApi();

  const market = useQuery({
    queryKey: ['market', slug],
    queryFn: () => api.markets.get(slug).then((response) => response.data),
  });

  const shops = useQuery({
    queryKey: ['market-shops', market.data?.id],
    queryFn: () => api.shops.inMarket(market.data?.id ?? '', { limit: 100 }).then((r) => r.data),
    enabled: Boolean(market.data?.id),
  });

  if (market.isPending || shops.isPending) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (market.isError || shops.isError || !shops.data) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Ochib bo'lmadi.</Text>
      </View>
    );
  }

  const sorted = [...shops.data].sort((a, b) => Number(b.isOpenNow) - Number(a.isOpenNow));

  return (
    <FlatList
      data={sorted}
      keyExtractor={(shop) => shop.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={styles.muted}>Bu bozorda do'kon yo'q.</Text>}
      renderItem={({ item }) => (
        <Link href={{ pathname: '/shop/[slug]', params: { slug: item.slug } }} asChild>
          <Pressable style={styles.card}>
            <View style={styles.statusRow}>
              <View style={[styles.dot, item.isOpenNow ? styles.dotOpen : styles.dotShut]} />
              <Text style={styles.status}>{item.isOpenNow ? 'OCHIQ' : 'YOPIQ'}</Text>
            </View>
            <Text style={styles.cardTitle}>{localized(item.name, Locale.UZ_LATN)}</Text>
            <Text style={styles.cardMeta}>
              {[item.sectionCode, item.stallNo ? `${item.stallNo}-do'kon` : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Text style={styles.cardCount}>{item.productCount} mahsulot</Text>
          </Pressable>
        </Link>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 6, borderWidth: 1, borderColor: theme.border, padding: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOpen: { backgroundColor: theme.tile },
  dotShut: { backgroundColor: theme.faint },
  status: { fontSize: 11, letterSpacing: 1, color: theme.muted },
  cardTitle: { fontSize: 17, fontWeight: '600', color: theme.ink },
  cardMeta: { marginTop: 4, fontSize: 13, color: theme.muted },
  cardCount: { marginTop: 10, fontSize: 12, color: theme.faint },
  muted: { color: theme.muted, textAlign: 'center', marginTop: 32 },
  error: { color: theme.pomegranate },
});
