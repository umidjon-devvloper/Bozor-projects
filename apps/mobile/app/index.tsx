import { Link } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { localized } from '@bozorlar/api-client';
import type { MarketResponse } from '@bozorlar/contracts';
import { Locale } from '@bozorlar/types';
import { useApi } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * Pick a bazaar.
 *
 * A `FlatList` rather than a scrolling column of views: the republic has hundreds of markets
 * and a phone that renders all of them at once drops frames on exactly the mid-range hardware
 * most of this audience carries.
 *
 * Whether the market is open leads, as it does on the web, and for a stronger reason here — a
 * phone is what somebody checks while already walking towards it.
 */
export default function MarketsScreen() {
  const api = useApi();

  const markets = useQuery({
    queryKey: ['markets'],
    queryFn: () => api.markets.list({ limit: 100 }).then((response) => response.data),
  });

  if (markets.isPending) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (markets.isError) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Bozorlarni ochib bo'lmadi.</Text>
        <Pressable onPress={() => void markets.refetch()} style={styles.retry}>
          <Text style={styles.retryText}>Qayta urinish</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      data={markets.data}
      keyExtractor={(market) => market.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={styles.muted}>Hozircha bozor yo'q.</Text>}
      renderItem={({ item }) => <MarketCard market={item} />}
    />
  );
}

function MarketCard({ market }: { market: MarketResponse }) {
  return (
    <Link href={{ pathname: '/market/[slug]', params: { slug: market.slug } }} asChild>
      <Pressable style={styles.card}>
        <View style={styles.statusRow}>
          <View style={[styles.dot, market.isOpenNow ? styles.dotOpen : styles.dotShut]} />
          <Text style={styles.status}>{market.isOpenNow ? 'OCHIQ' : 'YOPIQ'}</Text>
        </View>
        <Text style={styles.cardTitle}>{localized(market.name, Locale.UZ_LATN)}</Text>
        <Text style={styles.cardMeta}>{localized(market.address, Locale.UZ_LATN)}</Text>
        <Text style={styles.cardCount}>
          {market.shopCount} do'kon · {market.productCount} mahsulot
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
  },
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
  retry: { borderWidth: 1, borderColor: theme.border, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: theme.ink },
});
