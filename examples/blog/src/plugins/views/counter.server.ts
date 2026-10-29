import { DurableObject } from "cloudflare:workers";

/** One counter per document. */
export class ViewCounter extends DurableObject {
  async hit(): Promise<number> {
    const views = ((await this.ctx.storage.get<number>("views")) ?? 0) + 1;
    await this.ctx.storage.put("views", views);
    return views;
  }

  async views(): Promise<number> {
    return (await this.ctx.storage.get<number>("views")) ?? 0;
  }
}
