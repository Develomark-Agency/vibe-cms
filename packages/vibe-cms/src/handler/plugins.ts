import { loadLazy, IMPL, type PluginDescriptor } from "../descriptor.ts";
import type { ServerContext, ServerHooks, ServerPlugin } from "../server/index.ts";

export interface LoadedPlugin {
  name: string,
  hooks: ServerHooks
}

export type HookArgs<K extends keyof ServerHooks> = NonNullable<ServerHooks[K]> extends (...args: infer A) => unknown ? A : never;

type TransformHook = "content.beforeValidate" | "content.beforeWrite" | "content.beforeDelete" | "content.read" | "media.beforeUpload";

export class PluginHost {
  constructor(readonly plugins: LoadedPlugin[]) {}

  static async load(
    descriptors: readonly PluginDescriptor[],
    context: (plugin: PluginDescriptor) => ServerContext
  ): Promise<PluginHost> {
    const loaded: LoadedPlugin[] = [];
    for(const plugin of descriptors) {
      const server = plugin[IMPL].server;
      if(!server) continue;
      const define = await loadLazy(server) as ServerPlugin | undefined;
      if(typeof define !== "function") {
        throw new Error(`vibe-cms: plugin "${plugin.name}" server entry must default-export defineServer(...)`);
      }
      loaded.push({ name: plugin.name, hooks: await define(context(plugin)) });
    }
    return new PluginHost(loaded);
  }

  /** Transforming hooks run in config order, each mutating `output`. */
  async transform<K extends TransformHook>(hook: K, ...args: HookArgs<K>): Promise<void> {
    for(const plugin of this.plugins) {
      const fn = plugin.hooks[hook] as ((...a: HookArgs<K>) => unknown) | undefined;
      if(fn) await fn(...args);
    }
  }

  /** Observing hooks run concurrently; failures are logged, never thrown. */
  observe(input: Parameters<NonNullable<ServerHooks["content.afterWrite"]>>[0]): Promise<unknown> {
    return Promise.all(this.plugins.map(async plugin => {
      try {
        await plugin.hooks["content.afterWrite"]?.(input);
      } catch (error) {
        console.error(`vibe-cms: plugin "${plugin.name}" content.afterWrite failed`, error);
      }
    }));
  }

  get has(): { read: boolean } {
    return { read: this.plugins.some(p => p.hooks["content.read"]) };
  }

  analyzers(): Array<[string, (bytes: Uint8Array, mime: string) => unknown]> {
    return this.plugins.flatMap(p => Object.entries(p.hooks["media.analyze"] ?? {}));
  }

  route(name: string): LoadedPlugin | undefined {
    return this.plugins.find(p => p.name === name);
  }
}
