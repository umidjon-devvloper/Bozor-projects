import { Link } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatSom } from '@bozorlar/api-client';
import { useApi, useSession } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * The products somebody is waiting on.
 *
 * This is the list the restock and price-drop notifications are sent from, so it shows the same
 * two facts the notification carries. A followed product that has gone unavailable stays here
 * with the reason — removing it would silently end the alert the person is waiting for, which
 * is the one thing this screen must never do.
 */
export default function FavouritesScreen() {
  const api = useApi();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const favourites = useQuery({
    queryKey: ['favourites'],
    queryFn: () => api.favourites.products({ limit: 50 }).then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const unfollow = useMutation({
    mutationFn: (productId: string) => api.favourites.remove('PRODUCT', productId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favourites'] }),
  });

  if (status === 'signed-out') {
    return (
      <View style={styles.centre}>
        <Text style={styles.muted}>Kuzatilayotganlarni ko'rish uchun kiring.</Text>
      </View>
    );
  }

  if (favourites.isPending) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (favourites.isError) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Ro'yxatni ochib bo'lmadi.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={favourites.data}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <View style={styles.centre}>
          <Text style={styles.muted}>Hali hech narsa kuzatilmayapti.</Text>
          <Text style={styles.hint}>
            Mahsulot sahifasida «Kuzatish» tugmasini bossangiz, narx tushganda yoki tugagan
            mahsulot qaytganda xabar beramiz.
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Link href={{ pathname: '/product/[slug]', params: { slug: item.slug } }} asChild>
              <Pressable>
                <Text style={styles.name}>{item.name}</Text>
              </Pressable>
            </Link>
            <Text style={item.isPurchasable ? styles.available : styles.gone}>
              {item.isPurchasable
                ? 'Hozir bor'
                : item.unavailableReason === 'OUT_OF_STOCK'
                  ? 'Bugun tugagan'
                  : 'Sotuvda emas'}
            </Text>
          </View>

          <View style={styles.rowRight}>
            <Text style={styles.price}>
              {formatSom(item.price)}
              <Text style={styles.unit}> /{item.unit}</Text>
            </Text>
            <Pressable onPress={() => unfollow.mutate(item.productId)}>
              <Text style={styles.remove}>To'xtatish</Text>
            </Pressable>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12, flexGrow: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 14,
  },
  rowText: { flex: 1 },
  rowRight: { alignItems: 'flex-end', gap: 6 },
  name: { fontSize: 16, fontWeight: '600', color: theme.ink },
  available: { marginTop: 4, fontSize: 12, color: theme.tile },
  gone: { marginTop: 4, fontSize: 12, color: theme.pomegranate },
  price: { fontSize: 16, fontWeight: '700', color: theme.ink },
  unit: { fontSize: 11, fontWeight: '400', color: theme.muted },
  remove: { fontSize: 12, color: theme.muted },
  muted: { color: theme.muted, textAlign: 'center' },
  hint: { color: theme.faint, fontSize: 13, textAlign: 'center' },
  error: { color: theme.pomegranate },
});
