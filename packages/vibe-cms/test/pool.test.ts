import { describe, expect, test } from "bun:test";
import { pool } from "../src/backups/pool.ts";

/** Work that takes a moment, and records how many ran together and in what order they started. */
function tracker() {
  let running = 0;
  let weight = 0;
  const seen = { max: 0, maxWeight: 0, started: [] as number[], finished: [] as number[] };
  return {
    seen,
    work(sizes: number[], ms = 5) {
      return async (item: number, index: number) => {
        running++;
        weight += sizes[index]!;
        seen.max = Math.max(seen.max, running);
        seen.maxWeight = Math.max(seen.maxWeight, weight);
        seen.started.push(index);
        await new Promise(resolve => setTimeout(resolve, ms));
        running--;
        weight -= sizes[index]!;
        seen.finished.push(index);
      };
    }
  };
}

function range(n: number) {
  return Array.from({ length: n }, (_, i) => i);
}

describe("pool", () => {
  test("runs at most `limit` at once, and everything", async () => {
    const t = tracker();
    const sizes = range(20).map(() => 1);
    await pool(range(20), { limit: 4, budget: 1000, weight: () => 1 }, t.work(sizes));
    expect(t.seen.max).toBe(4);
    expect(t.seen.finished.toSorted((a, b) => a - b)).toEqual(range(20));
  });

  test("starts items in order", async () => {
    const t = tracker();
    await pool(range(10), { limit: 3, budget: 1000, weight: () => 1 }, t.work(range(10).map(() => 1)));
    expect(t.seen.started).toEqual(range(10));
  });

  test("keeps what's in flight within the budget: many small ones together, big ones alone", async () => {
    const t = tracker();
    const sizes = [1, 1, 1, 1, 50, 50, 1, 1, 1, 1];
    await pool(range(10), { limit: 6, budget: 60, weight: i => sizes[i]! }, t.work(sizes));
    expect(t.seen.maxWeight).toBeLessThanOrEqual(60);
    // Two big ones never run together, though six could by count.
    expect(t.seen.max).toBeGreaterThan(1);
  });

  test("an item heavier than the whole budget still runs, by itself", async () => {
    const t = tracker();
    const sizes = [500, 1, 500];
    await pool(range(3), { limit: 6, budget: 100, weight: i => sizes[i]! }, t.work(sizes));
    expect(t.seen.max).toBe(1);
    expect(t.seen.finished.toSorted()).toEqual([0, 1, 2]);
  });

  test("the item at the front isn't passed over by lighter ones behind it", async () => {
    const t = tracker();
    const sizes = [10, 50, 1, 1, 1];
    await pool(range(5), { limit: 6, budget: 55, weight: i => sizes[i]! }, t.work(sizes, 10));
    // 10 and 50 don't fit together under 55 (60), so 50 waits for 10, and the small ones wait behind 50.
    expect(t.seen.started.slice(0, 2)).toEqual([0, 1]);
    expect(t.seen.started.indexOf(1)).toBeLessThan(t.seen.started.indexOf(2));
  });

  test("a failure stops new work, lets running work finish, and is thrown", async () => {
    const t = tracker();
    const sizes = range(10).map(() => 1);
    const run = t.work(sizes, 10);
    await expect(pool(range(10), { limit: 2, budget: 1000, weight: () => 1 }, async (item, index) => {
      if(index === 3) throw new Error("boom");
      await run(item, index);
    })).rejects.toThrow("boom");
    // Nothing after the failure started, and what was running had finished by the time it threw.
    expect(Math.max(...t.seen.started)).toBeLessThan(6);
    expect(t.seen.started.length).toBe(t.seen.finished.length);
  });

  test("nothing to do is fine", async () => {
    await pool([], { limit: 3, budget: 10, weight: () => 1 }, async () => {});
  });
});
