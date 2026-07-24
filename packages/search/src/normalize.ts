/**
 * Search normalisation for Uzbek.
 *
 * Uzbek is written in two alphabets, and which one a person types depends on their age, their
 * keyboard and their habit. A seller lists `Goʻsht`, a buyer searches `гўшт`, another types
 * `gosht` because the modifier letter is awkward on a phone. All three mean beef, and a
 * search index that cannot see that is a search index nobody uses.
 *
 * The approach is to index and query a canonical ASCII form alongside the original: the
 * original preserves display and exact matching, the canonical form makes the three spellings
 * above collide.
 */

/** Uzbek and Russian Cyrillic to Uzbek Latin, following the official correspondence. */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: "g'", д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ў: "o'", ф: 'f', х: 'x', ҳ: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Every apostrophe-like character a keyboard or paste can produce for `oʻ` and `gʻ`. */
const MODIFIERS = /[ʻʼ'`’‘´ʹ]/g;

export function cyrillicToLatin(input: string): string {
  let output = '';
  for (const char of input.toLowerCase()) {
    output += CYRILLIC_TO_LATIN[char] ?? char;
  }
  return output;
}

/**
 * The canonical form used for matching.
 *
 * Modifier letters are dropped rather than replaced, so `goʻsht` and `gosht` collide. `x` and
 * `h` are folded together because Uzbek `x` (х) and `h` (ҳ) are routinely swapped in writing —
 * `xolodilnik` and `holodilnik` are the same word to everyone except a strict matcher. `ts`
 * folds to `s` for the same reason.
 *
 * This is aggressive on purpose. It runs on a parallel field, never on the displayed text, so
 * an over-eager fold costs a few extra results rather than a wrong product name.
 */
export function normalizeForSearch(input: string): string {
  return cyrillicToLatin(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(MODIFIERS, '')
    .replace(/ts/g, 's')
    .replace(/x/g, 'h')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Everything worth indexing for one piece of localised text.
 *
 * Both the original and the canonical form go into the index: the original so an exact,
 * correctly-spelled search ranks first, the canonical so the other two spellings find it at
 * all.
 */
export function searchVariants(values: ReadonlyArray<string | null | undefined>): {
  original: string;
  normalized: string;
} {
  const present = values.filter((value): value is string => Boolean(value && value.trim()));
  const unique = [...new Set(present.map((value) => value.trim()))];
  const normalized = [...new Set(unique.map(normalizeForSearch).filter(Boolean))];
  return { original: unique.join(' '), normalized: normalized.join(' ') };
}

/**
 * Prepares a user's query.
 *
 * Trimmed to a sane length before it reaches the engine — an unbounded query string is a
 * cheap way to make somebody else's search slow.
 */
export function normalizeQuery(input: string): { raw: string; normalized: string } {
  const raw = input.trim().slice(0, 120);
  return { raw, normalized: normalizeForSearch(raw) };
}
