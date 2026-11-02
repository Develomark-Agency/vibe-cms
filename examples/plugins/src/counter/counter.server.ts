import { DurableObject } from "cloudflare:workers";

/** One instance per document. */
export class Counter extends DurableObject {
  async hit(): Promise<number> {
    const hits = ((await this.ctx.storage.get<number>("hits")) ?? 0) + 1;
    await this.ctx.storage.put("hits", hits);
    return hits;
  }
}
