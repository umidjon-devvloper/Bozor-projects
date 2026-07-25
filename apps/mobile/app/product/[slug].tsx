import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, formatQuantity, formatSom, localized } from '@bozorlar/api-client';
import { Locale } from '@bozorlar/types';
import { useApi, useSession } from '@bozorlar/session';
import { registerForPush } from '@/push';
import { theme } from '@/theme';

/**
 * One product: what it costs, whether it can be had, and how much must be bought.
 *
 * The stepper obeys the product's own minimum and step rather than counting in ones, exactly as
 * on the web — produce is sold in quarter and half kilos and the checkout enforces it, so a
 * control that allowed 300g of something sold in half-kilos would be building a rejection.
 * Quantities stay integer thousandths; a phone doing float arithmetic on a weight is a dispute
 * at the stall.
 */
export default function ProductScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const api = useApi();
  const router = useRouter();
  const { status } = useSession();
  const queryClient = useQueryClient();

  const product = useQuery({
    queryKey: ['product', slug],
    queryFn: () => api.products.get(slug).then((response) => response.data),
  });

  const [qty, setQty] = useState<bigint | null>(null);
  const [following, setFollowing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the quantity from the product's own minimum once it arrives.
  useEffect(() => {
    if (product.data && qty === null) {
      const min = BigInt(product.data.minOrderQty.value);
      const step = BigInt(product.data.stepQty.value);
      setQty(min > 0n ? min : step);
    }
  }, [product.data, qty]);

  useEffect(() => {
    if (status !== 'signed-in' || !product.data) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.favourites.status([product.data.id]);
        if (!cancelled) setFollowing(data.followed.includes(product.data.id));
      } catch {
        // Not knowing whether it is followed is not worth an error message; the button simply
        // starts in the unfollowed state and a tap corrects it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, product.data, status]);

  const addToCart = useMutation({
    mutationFn: () => api.cart.addItem(product.data?.id ?? '', (qty ?? 0n).toString()),
    onSuccess: () => {
      setError(null);
      setMessage("Savatga qo'shildi");
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : "Qo'shib bo'lmadi."),
  });

  const follow = useMutation({
    mutationFn: async () => {
      const next = !following;
      if (next) await api.favourites.add('PRODUCT', product.data?.id ?? '');
      else await api.favourites.remove('PRODUCT', product.data?.id ?? '');
      return next;
    },
    onSuccess: (next) => {
      setFollowing(next);
      setError(null);
      /**
       * The first follow is the moment push is worth asking about: the person has just told
       * the platform they want to be told something. Asking at launch, before that, is how the
       * permission gets refused for good.
       */
      if (next) void registerForPush(api, Locale.UZ_LATN);
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? (caught.detail ?? caught.message) : 'Saqlanmadi.'),
  });

  if (product.isPending || qty === null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (product.isError || !product.data) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Mahsulot topilmadi.</Text>
      </View>
    );
  }

  const item = product.data;
  const unit = item.availableQty.unit;
  const step = BigInt(item.stepQty.value);
  const min = BigInt(item.minOrderQty.value);
  const available = BigInt(item.availableQty.value);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{localized(item.name, Locale.UZ_LATN)}</Text>

      <View style={styles.board}>
        {item.oldPrice ? (
          <Text style={styles.oldPrice}>{formatSom(item.oldPrice.amount)}</Text>
        ) : null}
        <Text style={styles.price}>{formatSom(item.price.amount)}</Text>
        <Text style={styles.unit}>so'm/{unit}</Text>
      </View>

      {item.isPurchasable ? (
        <Text style={styles.stock}>
          Hozir bor — {formatQuantity(item.availableQty.value, unit)}
        </Text>
      ) : (
        <View style={styles.goneBox}>
          <Text style={styles.gone}>Bugun tugagan</Text>
          <Text style={styles.meta}>Kuzatsangiz, qaytib kelganda xabar beramiz.</Text>
        </View>
      )}

      {item.isPurchasable ? (
        <View style={styles.stepperRow}>
          <Pressable
            onPress={() => setQty(qty - step)}
            disabled={qty - step < min}
            style={[styles.stepButton, qty - step < min && styles.disabled]}
          >
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <Text style={styles.qty}>{formatQuantity(qty.toString(), unit)}</Text>
          <Pressable
            onPress={() => setQty(qty + step)}
            disabled={qty + step > available}
            style={[styles.stepButton, qty + step > available && styles.disabled]}
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      ) : null}

      {item.isPurchasable ? (
        <Pressable
          onPress={() => {
            if (status !== 'signed-in') {
              router.push('/kirish');
              return;
            }
            addToCart.mutate();
          }}
          disabled={addToCart.isPending}
          style={styles.primary}
        >
          {addToCart.isPending ? (
            <ActivityIndicator color={theme.paper} />
          ) : (
            <Text style={styles.primaryText}>
              {status === 'signed-in' ? "Savatga qo'shish" : "Kirib qo'shish"}
            </Text>
          )}
        </Pressable>
      ) : null}

      <Pressable
        onPress={() => {
          if (status !== 'signed-in') {
            router.push('/kirish');
            return;
          }
          follow.mutate();
        }}
        style={[styles.secondary, following && styles.secondaryActive]}
      >
        <Text style={following ? styles.secondaryTextActive : styles.secondaryText}>
          {following ? '★  Kuzatilmoqda' : '☆  Kuzatish'}
        </Text>
      </Pressable>

      {message ? <Text style={styles.ok}>{message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.rules}>
        <Text style={styles.rulesTitle}>Qanday sotiladi</Text>
        <Text style={styles.meta}>
          Eng kam: {formatQuantity(item.minOrderQty.value, item.minOrderQty.unit)}
        </Text>
        <Text style={styles.meta}>
          Qadam: {formatQuantity(item.stepQty.value, item.stepQty.unit)}
        </Text>
        <Text style={styles.meta}>Tortishdagi farq: ±{item.tolerancePercent}%</Text>
        <Text style={styles.footnote}>
          Mahsulot qo'lda tortiladi, to'lov haqiqiy og'irlik bo'yicha hisoblanadi.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 14 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '700', color: theme.ink },
  board: {
    alignSelf: 'flex-start',
    backgroundColor: theme.slate,
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'flex-end',
  },
  oldPrice: { fontSize: 12, color: theme.chalkDim, textDecorationLine: 'line-through' },
  price: { fontSize: 32, fontWeight: '700', color: theme.chalk },
  unit: { fontSize: 11, color: theme.chalkDim },
  stock: { fontSize: 14, color: theme.muted },
  goneBox: { backgroundColor: 'rgba(156,42,36,0.08)', borderRadius: 6, padding: 12, gap: 4 },
  gone: { color: theme.pomegranate, fontWeight: '600' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepButton: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  disabled: { opacity: 0.3 },
  stepText: { fontSize: 20, color: theme.ink },
  qty: { fontSize: 17, fontWeight: '600', color: theme.ink, minWidth: 100, textAlign: 'center' },
  primary: { backgroundColor: theme.tile, borderRadius: 6, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: theme.paper, fontSize: 16, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryActive: { borderColor: theme.saffron, backgroundColor: 'rgba(227,160,47,0.12)' },
  secondaryText: { color: theme.muted, fontSize: 15 },
  secondaryTextActive: { color: theme.saffron, fontSize: 15, fontWeight: '600' },
  rules: { marginTop: 10, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 14, gap: 4 },
  rulesTitle: { fontSize: 15, fontWeight: '600', color: theme.ink, marginBottom: 4 },
  meta: { fontSize: 13, color: theme.muted },
  footnote: { marginTop: 6, fontSize: 12, color: theme.faint },
  ok: { color: theme.tile, fontSize: 14 },
  error: { color: theme.pomegranate, fontSize: 14 },
});
