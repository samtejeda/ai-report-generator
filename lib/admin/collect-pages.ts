/**
 * The list routes clamp a page to 100 rows, so a picker that read one page would silently hide
 * the 101st client. This reads pages until a short one, up to `cap` items, and says when it
 * stopped early so the screen can say so too.
 */
export async function collectPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  { pageSize = 100, cap = 500 }: { pageSize?: number; cap?: number } = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const want = cap + 1; // one extra row tells us whether there was more
  const items: T[] = [];
  while (items.length < want) {
    const limit = Math.min(pageSize, want - items.length);
    const page = await fetchPage(items.length, limit);
    items.push(...page);
    if (page.length < limit) break;
  }
  return { items: items.slice(0, cap), truncated: items.length > cap };
}
