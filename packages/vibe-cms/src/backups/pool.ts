/**
 * Runs `work` for every item with a few going at once, limited by how many AND by how much memory they may
 * hold together: each item has a weight, and the running ones' weights never add up to more than the budget.
 *
 * Items start in order. The one at the front waits until it fits, so a heavy item can't be passed over
 * for ever, but it always starts when nothing else is running, however heavy it is. If one fails, no new
 * item starts, the ones already running finish, and the first failure is thrown.
 */
export interface PoolOptions<T> {
  /** At most this many items at once. */
  limit: number,
  /** At most this much weight at once, except that a single item may exceed it when it's the only one. */
  budget: number,
  weight(item: T): number
}

export async function pool<T>(items: readonly T[], options: PoolOptions<T>, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let running = 0;
  let used = 0;
  let failure: { error: unknown } | undefined;
  await new Promise<void>(resolve => {
    function pump() {
      while(!failure && next < items.length && running < Math.max(1, options.limit)) {
        const weight = Math.max(0, options.weight(items[next]!));
        if(running > 0 && used + weight > options.budget) break;
        const index = next++;
        running++;
        used += weight;
        work(items[index]!, index)
          .catch(error => {
            failure ??= { error };
          })
          .finally(() => {
            running--;
            used -= weight;
            pump();
          });
      }
      if(running === 0 && (failure || next >= items.length)) resolve();
    }
    pump();
  });
  if(failure) throw failure.error;
}
