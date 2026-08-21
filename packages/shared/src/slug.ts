/**
 * Convert a name to a URL/filesystem-safe slug.
 *
 * Rules:
 * - Lowercase ASCII letters
 * - Keep alphanumeric, CJK unified ideographs, kana, hangul
 * - Replace other chars with hyphens
 * - Collapse consecutive hyphens
 * - Trim leading/trailing hyphens
 * - If result is empty (e.g. only symbols), fall back to hex hash of input
 */
export function slugify(name: string): string {
  // \p{Script=Han} covers CJK, \p{Script=Hiragana/Katakana} covers Japanese kana,
  // \p{Script=Hangul} covers Korean. Using Unicode property escapes (ES2018+).
  const slug = name
    .toLowerCase()
    .replace(
      /[^a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
      '-',
    )
    .replace(/^-|-$/g, '')

  if (slug) return slug

  // Fallback: simple hash for names with no usable characters
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  return `id-${(hash >>> 0).toString(16)}`
}
