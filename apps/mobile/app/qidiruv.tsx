import { Link } from 'expo-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { formatSom } from '@bozorlar/api-client';
import type { SearchHit } from '@bozorlar/api-client';
import { useApi } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * Search across every stall.
 *
 * The query is submitted rather than typed-as-you-go. Each keystroke would be a request over a
 * mobile connection at a bazaar, and the index is not free to query — a debounce would still
 * fire several times per word. The submit key on the phone keyboard is the natural gesture and
 * it costs one request.
 */
export default function SearchScreen() {
  const api = useApi();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');

  const results = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search.products({ q: query, perPage: 30 }).then((r) => r.data),
    enabled: query.trim().length > 0,
  });

  return (
    <View style={styles.flex}>
      <View style={styles.searchBar}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => setQuery(draft.trim())}
          returnKeyType="search"
          placeholder="Pomidor, non, asal…"
          placeholderTextColor={theme.faint}
          style={styles.input}
        />
      </View>

      {query.trim().length === 0 ? (
        <Text style={styles.hint}>
          Mahsulot nomini yozing — respublika bo'ylab barcha do'konlardan qidiramiz.
        </Text>
      ) : results.isPending ? (
        <View style={styles.centre}>
          <ActivityIndicator color={theme.tile} />
        </View>
      ) : results.isError ? (
        <Text style={styles.error}>Qidiruv ishlamadi.</Text>
      ) : results.data.items.length === 0 ? (
        <Text style={styles.hint}>«{query}» bo'yicha hech narsa topilmadi.</Text>
      ) : (
        <FlatList
          data={results.data.items}
          keyExtractor={(hit) => hit.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <HitRow hit={item} />}
        />
      )}
    </View>
  );
}

function HitRow({ hit }: { hit: SearchHit }) {
  return (
    <Link href={{ pathname: '/product/[slug]', params: { slug: hit.id } }} asChild>
      <Pressable style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {hit.name}
          </Text>
          <Text style={styles.meta}>{hit.shop.name}</Text>
          {!hit.inStock ? <Text style={styles.gone}>Bugun tugagan</Text> : null}
        </View>
        <Text style={styles.price}>
          {formatSom(hit.price.amount)}
          <Text style={styles.unit}> /{hit.unit}</Text>
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchBar: { padding: 16, borderBottomWidth: 1, borderBottomColor: theme.border },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: theme.ink,
  },
  list: { padding: 16, gap: 12 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  meta: { marginTop: 3, fontSize: 12, color: theme.muted },
  gone: { marginTop: 3, fontSize: 12, color: theme.pomegranate },
  price: { fontSize: 16, fontWeight: '700', color: theme.ink },
  unit: { fontSize: 11, fontWeight: '400', color: theme.muted },
  hint: { padding: 20, color: theme.muted, fontSize: 14 },
  error: { padding: 20, color: theme.pomegranate },
});
