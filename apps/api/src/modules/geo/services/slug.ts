/**
 * Slug generation for Uzbek Latin text.
 *
 * Transliteration matters here: `Oʻzbekiston doʻkoni` must become `ozbekiston-dokoni`, not
 * `o-zbekiston-do-koni`. The modifier letters `ʻ` and `ʼ` are dropped rather than replaced
 * with hyphens, and Cyrillic input is transliterated so a shop named in Cyrillic still gets
 * a usable URL (SEARCH_SYSTEM.md uses the same normalisation rules).
 */
const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ў: 'o', ф: 'f', х: 'x', ҳ: 'h', ц: 's', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const MODIFIERS = /[ʻʼ'`’‘´]/g;

export function slugify(input: string): string {
  const lowered = input.toLowerCase().normalize('NFKD');
  let transliterated = '';
  for (const char of lowered) {
    transliterated += CYRILLIC_MAP[char] ?? char;
  }
  return transliterated
    .replace(MODIFIERS, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Appends a short random suffix and retries against a uniqueness probe.
 *
 * The unique index remains the real guarantee — this only avoids surfacing a duplicate-key
 * error for the common case of two stalls with the same name in different markets.
 */
export async function generateUniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
  maxAttempts = 6,
): Promise<string> {
  const root = slugify(base) || 'shop';
  if (!(await exists(root))) return root;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const candidate = `${root}-${suffix}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}
