import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, formatSom } from '@bozorlar/api-client';
import type { CartLineResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * The basket, and the order.
 *
 * Checkout is on this screen rather than behind another navigation step. On the web a separate
 * confirmation page is worth the click; on a phone at a bazaar, with one hand free and a weak
 * signal, every extra screen is a place to lose somebody. The quote is fetched when they
 * commit, not on arrival, so a basket that is merely being read does not hold real stock.
 */
export default function CartScreen() {
  const api = useApi();
  const router = useRouter();
  const { status } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const cart = useQuery({
    queryKey: ['cart'],
    queryFn: () => api.cart.get().then((response) => response.data),
    enabled: status === 'signed-in',
  });

  const remove = useMutation({
    mutationFn: (lineId: string) => api.cart.removeItem(lineId),
    onSuccess: (response) => queryClient.setQueryData(['cart'], response.data),
  });

  /**
   * One key per screen mount, so a tap that times out on a weak signal and is tapped again
   * returns the original order rather than placing a second one.
   */
  const idempotencyKey = useRef(
    `mob_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  );

  const order = useMutation({
    mutationFn: async () => {
      const quote = await api.checkout.quote();
      return api.orders.create(quote.data.quoteId, idempotencyKey.current);
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
      router.push('/buyurtmalarim');
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Buyurtma berilmadi.'),
  });

  if (status === 'signed-out') {
    return (
      <View style={styles.centre}>
        <Text style={styles.muted}>Savatni ko'rish uchun kiring.</Text>
        <Pressable onPress={() => router.push('/kirish')} style={styles.primary}>
          <Text style={styles.primaryText}>Kirish</Text>
        </Pressable>
      </View>
    );
  }

  if (cart.isPending || status === 'loading') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (cart.isError || !cart.data) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Savatni ochib bo'lmadi.</Text>
      </View>
    );
  }

  if (cart.data.items.length === 0) {
    return (
      <View style={styles.centre}>
        <Text style={styles.muted}>Savat bo'sh.</Text>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <FlatList
        data={cart.data.items}
        keyExtractor={(line) => line.lineId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <CartRow line={item} onRemove={() => remove.mutate(item.lineId)} />
        )}
      />

      <View style={styles.footer}>
        <View style={styles.totalRow}>
          <Text style={styles.muted}>{cart.data.itemCount} ta mahsulot</Text>
          <Text style={styles.total}>{formatSom(cart.data.subtotal.amount)} so'm</Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {cart.data.hasIssues ? (
          <Text style={styles.error}>
            Ba'zi mahsulotlarda muammo bor — buyurtma berishdan oldin tuzating.
          </Text>
        ) : (
          <Pressable
            onPress={() => order.mutate()}
            disabled={order.isPending}
            style={styles.primary}
          >
            {order.isPending ? (
              <ActivityIndicator color={theme.paper} />
            ) : (
              <Text style={styles.primaryText}>Buyurtma berish</Text>
            )}
          </Pressable>
        )}
        <Text style={styles.footnote}>To'lov do'konda, olib ketishda.</Text>
      </View>
    </View>
  );
}

function CartRow({ line, onRemove }: { line: CartLineResponse; onRemove: () => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.name}>{line.name}</Text>
        <Text style={styles.meta}>
          {line.qty.value} {line.qty.unit}
        </Text>
        {line.priceChanged ? <Text style={styles.changed}>Narx o'zgargan</Text> : null}
        {!line.purchasable ? <Text style={styles.error}>Hozir mavjud emas</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {line.lineTotal ? (
          <Text style={styles.lineTotal}>{formatSom(line.lineTotal.amount)}</Text>
        ) : null}
        <Pressable onPress={onRemove}>
          <Text style={styles.removeText}>O'chirish</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 12 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
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
  meta: { marginTop: 4, fontSize: 12, color: theme.muted },
  changed: { marginTop: 4, fontSize: 12, color: theme.saffron },
  lineTotal: { fontSize: 15, fontWeight: '600', color: theme.ink },
  removeText: { fontSize: 12, color: theme.muted },
  footer: { borderTopWidth: 1, borderTopColor: theme.border, padding: 16, gap: 10, backgroundColor: theme.paper },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  total: { fontSize: 22, fontWeight: '700', color: theme.ink },
  primary: { backgroundColor: theme.tile, borderRadius: 6, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: theme.paper, fontSize: 16, fontWeight: '600' },
  muted: { color: theme.muted },
  footnote: { fontSize: 12, color: theme.faint, textAlign: 'center' },
  error: { color: theme.pomegranate, fontSize: 13 },
});
