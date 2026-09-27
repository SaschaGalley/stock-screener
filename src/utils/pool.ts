/**
 * `fn` over `items`, at most `size` at a time, every outcome kept — and no new
 * item started once `keepGoing` says no, so a stop reaches the work that has
 * not begun. The outcomes of items never started are left out.
 */
export async function settledPool<T, R>(
  items: T[], size: number, fn: (item: T) => Promise<R>,
  keepGoing: () => Promise<boolean> = async () => true,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      if (!(await keepGoing())) return;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  }));
  return out.filter(Boolean);
}
