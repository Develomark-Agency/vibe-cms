import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { base, defineAction, listActions, router, runAction } from "../src/actions/define.ts";
import { inputJsonSchema } from "../src/actions/describe.ts";
import { isActionError } from "../src/actions/errors.ts";
import { Engine, type EngineState } from "../src/handler/engine.ts";
import type { Session } from "../src/server/index.ts";

const state = { roles: { map: { editor: { post: ["read", "write"] }, ops: { site: undefined, siteSettings: true } } } } as unknown as EngineState;

function ctx(session: Session | null) {
  return { engine: new Engine(state, { origin: "", session, trusted: false }) };
}

const actions = listActions(router({
  look: base({ summary: "Look", description: "Reads.", readOnly: true }).handler(() => "looked"),
  change: base({ summary: "Change", description: "Writes." }).handler(() => "changed"),
  tune: base({ summary: "Tune", description: "Needs site settings.", permit: { action: "write", scope: "site" } })
    .input(z.object({}))
    .handler(() => "tuned")
}), "seo");
const by = Object.fromEntries(actions.map(action => [action.path.at(-1)!, action]));

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if(isActionError(error)) return error.code;
    throw error;
  }
}

describe("plugin action access", () => {
  test("agents see an action only when it opts in", () => {
    expect(actions.map(action => action.mcp)).toEqual([false, false, false]);
    const [optIn] = listActions(router({ yes: base({ summary: "Yes", description: "Opts in.", mcp: true }).handler(() => 1) }), "seo");
    expect(optIn!.mcp).toBe(true);
    const [core] = listActions(router({ plain: base({ summary: "Plain", description: "Built in." }).handler(() => 1) }));
    expect(core!.mcp).toBe(true);
  });

  test("anonymous callers are refused", async () => {
    expect(await code(runAction(by.look!, ctx(null), {}))).toBe("UNAUTHORIZED");
  });

  test("read-only connections only run readOnly actions", async () => {
    const session: Session = { sub: "a", roles: ["editor"], readOnly: true };
    expect(await runAction(by.look!, ctx(session), {})).toBe("looked");
    expect(await code(runAction(by.change!, ctx(session), {}))).toBe("FORBIDDEN");
  });

  test("the permit is checked against the user's roles", async () => {
    expect(await code(runAction(by.tune!, ctx({ sub: "a", roles: ["editor"] }), {}))).toBe("FORBIDDEN");
    expect(await runAction(by.tune!, ctx({ sub: "b", roles: ["ops"] }), {})).toBe("tuned");
    expect(await runAction(by.change!, ctx({ sub: "a", roles: ["editor"] }), {})).toBe("changed");
  });
});

describe("action inputs", () => {
  test("an input must be describable as JSON Schema", () => {
    const noJsonSchema = { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } } as never;
    expect(() => inputJsonSchema(noJsonSchema)).toThrow("Standard JSON Schema");
  });

  test("defineAction without an input takes none", async () => {
    const [entry] = listActions({ ping: defineAction({ summary: "Ping", description: "Pongs.", handler: () => "pong" }) }, "seo");
    expect(inputJsonSchema(entry!.input)).toMatchObject({ type: "object", properties: {} });
    expect(await runAction(entry!, ctx({ sub: "a", roles: ["editor"] }), {})).toBe("pong");
  });
});
