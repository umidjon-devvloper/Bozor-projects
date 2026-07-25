import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { formatSom } from '@bozorlar/api-client';
import type { OrderResponse } from '@bozorlar/contracts';
import { useApi, useSession } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * Orders, and the pickup code.
 *
 * The six digits are the point of this screen. They are shown large enough to be read off a
 * phone held out at arm's length across a stall, in daylight, by somebody who is not wearing
 * their glasses — which is the actual condition under which they get used.
 */
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Do'kon javobini kutmoqda",
  ACCEPTED: 'Qabul qilindi',
  PREPARING: 'Tayyorlanmoqda',
  READY_FOR_PICKUP: 'Olib ketishga tayyor',
  PENDING_ADJUSTMENT: "O'zgarish tasdiqlanishi kerak",
  PICKED_UP: 'Olindi',
  COMPLETED: 'Yakunlandi',
  REJECTED: "Do'kon rad etdi",
  EXPIRED: 'Javob kelmadi',
  CANCELLED: 'Bekor qilindi',
  DISPUTED: 'Nizo ochilgan',
  REFUNDED: 'Pul qaytarildi',
};

export default function OrdersScreen() {
  const api = useApi();
  const { status } = useSession();

  const orders = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.orders.list({ limit: 50 }).then((response) => response.data),
    enabled: status === 'signed-in',
    refetchInterval: 30_000,
  });

  if (status === 'signed-out') {
    return (
      <View style={styles.centre}>
        <Text style={styles.muted}>Buyurtmalarni ko'rish uchun kiring.</Text>
      </View>
    );
  }

  if (orders.isPending) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.tile} />
      </View>
    );
  }

  if (orders.isError) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>Buyurtmalarni ochib bo'lmadi.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={orders.data}
      keyExtractor={(order) => order.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={<Text style={styles.muted}>Hali buyurtma yo'q.</Text>}
      renderItem={({ item }) => <OrderCard order={item} />}
    />
  );
}

function OrderCard({ order }: { order: OrderResponse }) {
  const address = [
    order.shop.marketName,
    order.shop.sectionCode,
    order.shop.stallNo ? `${order.shop.stallNo}-do'kon` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.orderNo}>{order.orderNo}</Text>
        <Text style={styles.status}>{STATUS_LABEL[order.status] ?? order.status}</Text>
      </View>

      <Text style={styles.shop}>{order.shop.name}</Text>
      <Text style={styles.meta}>{address}</Text>

      {order.lines.map((line) => (
        <Text key={line.lineId} style={styles.line}>
          {line.name}
          <Text style={styles.meta}>
            {'  '}
            {(line.confirmedQty ?? line.orderedQty).value} {line.unit}
          </Text>
        </Text>
      ))}

      <Text style={styles.total}>{formatSom(order.totals.grand.amount)} so'm</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
  },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderNo: { fontSize: 12, color: theme.muted },
  status: { fontSize: 12, color: theme.tile },
  shop: { marginTop: 8, fontSize: 17, fontWeight: '600', color: theme.ink },
  meta: { fontSize: 12, color: theme.muted },
  line: { marginTop: 6, fontSize: 14, color: theme.ink },
  total: { marginTop: 12, fontSize: 18, fontWeight: '700', color: theme.ink },
  muted: { color: theme.muted, textAlign: 'center', marginTop: 32 },
  error: { color: theme.pomegranate },
});
