import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { listActions, runAction } from "../src/actions/define.ts";
import { isActionError } from "../src/actions/errors.ts";
import { pluginCan } from "../src/admin/app/client.ts";
import { defineConfig, type RoleRules } from "../src/index.ts";
import { definePlugin } from "../src/descriptor.ts";
import { canPlugin, permissionSummary, type Access } from "../src/handler/auth.ts";
import { Engine, type EngineState } from "../src/handler/engine.ts";
import { createHandler } from "../src/handler/index.ts";
import { PluginHost } from "../src/handler/plugins.ts";
import { roleSchema } from "../src/handler/roles.ts";
import { beyondReach, describeRules, fitRules, ruleIssues, staleKeys, withoutStale } from "../src/roles.ts";
import v from "../src/schema/index.ts";
import { defineAction, defineServer, type Session } from "../src/server/index.ts";
import { createD1, createR2, ctx } from "./helpers.ts";

const NewsletterPlugin = definePlugin()(() => ({
  name: "newsletter",
  options: {},
  permissions: {
    apiKey: { label: "API key", levels: ["view", { value: "edit", label: "Change it" }] },
    send: { label: "Send newsletters" },
    reports: { label: "Reports", readOnly: true }
  },
  server: async () => ({
    default: defineServer(({ can }) => ({
      routes: {
        "GET /check": (_request, { session }) => Response.json({ view: can(session, "apiKey"), edit: can(session, "apiKey", "edit"), send: can(session, "send") })
      },
      actions: {
        send: defineAction({ summary: "Send", description: "Sends.", permit: { permission: "send" }, handler: () => "sent" }),
        rotate: defineAction({ summary: "Rotate", description: "Changes the key.", permit: { permission: "apiKey", level: "edit" }, handler: () => "rotated" }),
        peek: defineAction({ summary: "Peek", description: "Looks at the key.", readOnly: true, permit: { permission: "apiKey", level: "view" }, handler: () => "peeked" })
      }
    }))
  })
}));

const config = defineConfig({
  plugins: [NewsletterPlugin()],
  collections: { post: { schema: v.object({ title: v.text() }) } }
});

const roles: Record<string, RoleRules> = {
  viewer: { post: ["read"], plugins: { newsletter: { apiKey: "view" } } },
  keeper: { plugins: { newsletter: { apiKey: "edit", reports: true } } },
  sender: { plugins: { newsletter: { send: true } } },
  boss: { all: true },
  plain: { post: ["read", "write"] },
  // A level the plugin doesn't have (any more): gives nothing.
  stale: { plugins: { newsletter: { apiKey: "admin" }, gone: { thing: true } } }
};

const access: Access = { config, roles: { map: roles } };
function as(...names: string[]): Session {
  return { sub: "u", roles: names };
}
const schema = roleSchema(config);

describe("declaring plugin permissions", () => {
  function define(permissions: Record<string, unknown>) {
    return definePlugin()(() => ({ name: "p", options: {}, permissions: permissions as never }))();
  }

  test("names, labels and levels are checked when the plugin is defined", () => {
    expect(() => define({ "bad name": { label: "x" } })).toThrow("names are letters");
    expect(() => define({ ok: {} })).toThrow("needs a label");
    expect(() => define({ ok: { label: "x", levels: [] } })).toThrow("can't be empty");
    expect(() => define({ ok: { label: "x", levels: ["none", "all"] } })).toThrow("\"none\"");
    expect(() => define({ ok: { label: "x", levels: ["a", "a"] } })).toThrow("must be different");
    expect(define({ ok: { label: "x", levels: ["a", "b"] } }).permissions).toEqual({ ok: { label: "x", levels: ["a", "b"] } });
  });

  test("the Roles page's schema lists them", () => {
    expect(schema.plugins).toEqual([{ name: "newsletter", permissions: NewsletterPlugin().permissions! }]);
  });
});

describe("checking plugin permissions", () => {
  function check(session: Session | null, permission: string, level?: string) {
    return canPlugin(access, session, { plugin: "newsletter", permission, ...(level ? { level } : {}) });
  }

  test("roles give a yes or no permission, and nobody else has it", () => {
    expect(check(as("sender"), "send")).toBe(true);
    expect(check(as("plain"), "send")).toBe(false);
    expect(check(as("viewer", "plain"), "send")).toBe(false);
    expect(check(null, "send")).toBe(false);
  });

  test("a level includes the ones below it, and no level asks for any", () => {
    expect(check(as("viewer"), "apiKey")).toBe(true);
    expect(check(as("viewer"), "apiKey", "view")).toBe(true);
    expect(check(as("viewer"), "apiKey", "edit")).toBe(false);
    expect(check(as("keeper"), "apiKey", "view")).toBe(true);
    expect(check(as("keeper"), "apiKey", "edit")).toBe(true);
    // Several roles: the most any gives.
    expect(check(as("viewer", "keeper"), "apiKey", "edit")).toBe(true);
  });

  test("owners, the dev sign-in and all roles have everything", () => {
    for(const session of [as("owner"), as("boss"), { sub: "dev", roles: ["dev"] }]) {
      expect(check(session, "apiKey", "edit")).toBe(true);
      expect(check(session, "send")).toBe(true);
    }
  });

  test("read-only connections only keep permissions marked readOnly", () => {
    expect(check({ ...as("keeper"), readOnly: true }, "apiKey")).toBe(false);
    expect(check({ ...as("keeper"), readOnly: true }, "reports")).toBe(true);
    expect(check({ ...as("owner"), readOnly: true }, "send")).toBe(false);
  });

  test("levels and plugins that aren't declared give nothing", () => {
    expect(check(as("stale"), "apiKey")).toBe(false);
  });

  test("asking for an undeclared permission or level is a mistake, not a refusal", () => {
    expect(() => check(as("owner"), "nope")).toThrow("doesn't declare");
    expect(() => check(as("owner"), "apiKey", "admin")).toThrow("doesn't have");
    expect(() => check(as("owner"), "send", "view")).toThrow("doesn't have");
  });

  test("the editor's summary lists what someone has, at their highest level", () => {
    expect(permissionSummary(access, as("viewer", "sender")).plugins).toEqual({ newsletter: { apiKey: "view", send: true } });
    expect(permissionSummary(access, as("boss")).plugins).toEqual({ newsletter: { apiKey: "edit", send: true, reports: true } });
    expect(permissionSummary(access, as("plain")).plugins).toEqual({});
  });

  test("cms.can reads the summary, with permissions named in full", () => {
    const can = pluginCan(config, () => ({ plugins: { newsletter: { apiKey: "view" } } }) as never);
    expect(can("newsletter.apiKey")).toBe(true);
    expect(can("newsletter.apiKey", "edit")).toBe(false);
    expect(can("newsletter.send")).toBe(false);
    expect(() => can("apiKey")).toThrow("<plugin>.<permission>");
    expect(() => can("newsletter.apiKey", "admin")).toThrow("no level");
  });
});

describe("plugin permissions in roles", () => {
  test("saving refuses permissions, plugins and levels the site doesn't have", () => {
    expect(ruleIssues({ plugins: { newsletter: { apiKey: "edit", send: true } } }, schema)).toEqual([]);
    expect(ruleIssues({ plugins: { other: { x: true } } }, schema)).toEqual(["\"other\" isn't a plugin with permissions on this site"]);
    expect(ruleIssues({ plugins: { newsletter: { nope: true } } }, schema)).toEqual(["\"nope\" isn't one of newsletter's permissions"]);
    expect(ruleIssues({ plugins: { newsletter: { apiKey: true } } }, schema)).toEqual(["plugins.newsletter.apiKey must be one of view, edit"]);
    expect(ruleIssues({ plugins: { newsletter: { send: "edit" } } }, schema)).toEqual(["plugins.newsletter.send must be true"]);
    expect(ruleIssues({ plugins: [] }, schema)).toHaveLength(1);
  });

  test("templates keep what fits and report the rest", () => {
    const { rules, skipped } = fitRules({ post: ["read"], plugins: { newsletter: { apiKey: "admin", send: true }, gone: { thing: true } } }, schema);
    expect(rules).toEqual({ post: ["read"], plugins: { newsletter: { send: true } } });
    expect(skipped).toEqual(["newsletter.apiKey has no level \"admin\"", "plugin gone isn't on this site"]);
  });

  test("stale grants are flagged and can be removed", () => {
    const stale = staleKeys(roles.stale!, schema);
    expect(stale).toEqual(["newsletter.apiKey", "gone.thing"]);
    expect(withoutStale({ ...roles.stale!, post: ["read"] }, stale)).toEqual({ post: ["read"] });
    expect(staleKeys(roles.keeper!, schema)).toEqual([]);
  });

  test("role managers can only give plugin permissions up to their own", () => {
    expect(beyondReach({ plugins: { newsletter: { apiKey: "view" } } }, [roles.keeper!], schema)).toEqual([]);
    expect(beyondReach({ plugins: { newsletter: { apiKey: "edit" } } }, [roles.viewer!], schema)).toEqual(["API key: Change it (newsletter)"]);
    expect(beyondReach({ plugins: { newsletter: { send: true } } }, [roles.keeper!], schema)).toEqual(["Send newsletters (newsletter)"]);
    expect(beyondReach({ plugins: { newsletter: { send: true } } }, [roles.boss!], schema)).toEqual([]);
    // Older sites send no plugins in their schema: nothing to compare.
    expect(beyondReach({ plugins: { newsletter: { send: true } } }, [roles.plain!], { types: schema.types, locales: schema.locales })).toEqual([]);
  });

  test("role descriptions mention them", () => {
    expect(describeRules(roles.sender!)).toBe("newsletter permissions");
  });
});

describe("plugin actions and routes", () => {
  async function host() {
    return PluginHost.load(config.plugins as never, () => ({ can: () => false }) as never);
  }

  async function run(name: string, session: Session) {
    const entry = (await host()).actions().index.get(`newsletter.${name}`)!;
    const engine = new Engine({ config, roles: { map: roles } } as unknown as EngineState, { origin: "", session, trusted: false });
    try {
      return await runAction(entry, { engine }, {});
    } catch (error) {
      if(isActionError(error)) return error.code;
      throw error;
    }
  }

  test("an action's permit can name the plugin's own permission", async () => {
    expect(await run("send", as("sender"))).toBe("sent");
    expect(await run("send", as("keeper"))).toBe("FORBIDDEN");
    expect(await run("rotate", as("keeper"))).toBe("rotated");
    expect(await run("rotate", as("viewer"))).toBe("FORBIDDEN");
    expect(await run("peek", as("viewer"))).toBe("peeked");
  });

  test("a permit naming an undeclared permission or level stops the site from starting", async () => {
    function plugin(permit: unknown) {
      return definePlugin()(() => ({
        name: "broken",
        options: {},
        permissions: { send: { label: "Send" } },
        server: async () => ({ default: defineServer(() => ({ actions: { go: defineAction({ summary: "Go", description: "Goes.", permit: permit as never, handler: () => 1 }) } })) })
      }))();
    }
    await expect(PluginHost.load([plugin({ permission: "nope" })], () => ({}) as never)).rejects.toThrow("doesn't declare");
    await expect(PluginHost.load([plugin({ permission: "send", level: "edit" })], () => ({}) as never)).rejects.toThrow("yes or no");
    expect(listActions({ go: defineAction({ summary: "Go", description: "Goes.", input: z.object({}), handler: () => 1 }) }, "broken")).toHaveLength(1);
  });

  test("routes check with can from the server entry's context", async () => {
    const env = { DB: createD1({ roles }), MEDIA: createR2() };
    const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) });
    async function call(token?: string) {
      return (await vibe.handle(new Request("https://site.test/_vibe/plugins/newsletter/check", { headers: token ? { authorization: `Bearer ${token}` } : {} }), env, ctx)).json();
    }
    expect(await call()).toEqual({ view: false, edit: false, send: false });
    const session = await vibe.handle(new Request("https://site.test/_vibe/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) }), env, ctx);
    const { token } = await session.json() as { token: string };
    expect(await call(token)).toEqual({ view: true, edit: true, send: true });
  });
});
