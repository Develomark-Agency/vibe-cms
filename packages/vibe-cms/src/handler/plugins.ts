import { coreActions } from "../actions/core.ts";
import { listActions, type ActionEntry } from "../actions/define.ts";
import { inputJsonSchema } from "../actions/describe.ts";
import { loadLazy, IMPL, type PluginDescriptor } from "../descriptor.ts";
import type { ServerContext, ServerHooks, ServerPlugin } from "../server/index.ts";

export interface LoadedPlugin {
  name: string,
  hooks: ServerHooks
}

export type HookArgs<K extends keyof ServerHooks> = NonNullable<ServerHooks[K]> extends (...args: infer A) => unknown ? A : never;

type TransformHook = "content.beforeValidate" | "content.beforeWrite" | "content.beforeDelete" | "content.read" | "media.beforeUpload";

/** Every action the site serves: the built-in ones and each plugin's, by name. */
export interface ActionRegistry {
  list: ActionEntry[],
  index: Map<string, ActionEntry>
}

export class PluginHost {
  private registry: ActionRegistry | undefined;

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
    const host = new PluginHost(loaded);
    // Fail at boot, not on the first call, if an action is malformed or a name is taken.
    host.actions();
    return host;
  }

  /** Plugins' notes on using their MCP tools, by plugin name: only for plugins that offer some. */
  mcpInstructions(): Record<string, string> {
    const { list } = this.actions();
    return Object.fromEntries(this.plugins.flatMap(plugin => plugin.hooks.instructions && list.some(action => action.plugin === plugin.name && action.mcp) ? [[plugin.name, plugin.hooks.instructions]] : []));
  }

  /** Built-in actions, then each plugin's under its name: `seo.audit`. Built once. */
  actions(): ActionRegistry {
    if(this.registry) return this.registry;
    const list = listActions(coreActions);
    const groups = new Set(Object.keys(coreActions));
    for(const plugin of this.plugins) {
      if(!plugin.hooks.actions) continue;
      if(groups.has(plugin.name)) throw new Error(`vibe-cms: plugin "${plugin.name}" has actions, but its name is taken by built-in actions`);
      for(const [key, action] of Object.entries(plugin.hooks.actions)) {
        if(typeof action !== "object" || action === null || !("~orpc" in action)) throw new Error(`vibe-cms: plugin "${plugin.name}" action "${key}" isn't an action: make it with defineAction`);
      }
      const added = listActions({ [plugin.name]: plugin.hooks.actions }, plugin.name);
      for(const entry of added) {
        // Agents and listings need the input described, so find out now whether it can be.
        try {
          inputJsonSchema(entry.input, { files: "json" });
        } catch (error) {
          throw new Error(`vibe-cms: action "${entry.name}": ${(error as Error).message}`);
        }
      }
      list.push(...added);
    }
    const index = new Map<string, ActionEntry>();
    for(const entry of list) {
      if(index.has(entry.name)) throw new Error(`vibe-cms: two actions are named "${entry.name}"`);
      index.set(entry.name, entry);
    }
    return this.registry = { list, index };
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
