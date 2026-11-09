/**
 * Waits for the CI workflow (.github/workflows/ci.yml) to pass on a commit, which must already be pushed.
 * Used by scripts/release.ts, and runnable alone: `bun scripts/wait-for-ci.ts [sha]` (defaults to HEAD).
 */
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

type Run = { databaseId: number; status: string; conclusion: string };

async function run(cmd: string[], inherit = false) {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe" });
  const [out, err, code] = await Promise.all([inherit ? "" : new Response(proc.stdout).text(), inherit ? "" : new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

async function listRuns(sha: string): Promise<Run[]> {
  const { out, err, code } = await run(["gh", "run", "list", "--workflow", "ci.yml", "--commit", sha, "--json", "databaseId,status,conclusion"]);
  if(code) throw new Error(`Couldn't list CI runs with gh: ${err || `exit ${code}`}`);
  return JSON.parse(out);
}

/** Resolves once CI has passed on `sha`; throws (with a reason) if it failed, was cancelled, or never started. */
export async function waitForCi(sha: string, { appearTimeoutMs = 90_000, log = console.log } = {}) {
  const short = sha.slice(0, 7);
  const started = Date.now();
  let announced = false;

  while(true) {
    const runs = await listRuns(sha);
    if(runs.some(r => r.conclusion === "success")) {
      log(`✓ CI has passed on ${short}`);
      return;
    }

    const active = runs.find(r => r.status !== "completed");
    if(active) {
      log(`… Waiting for CI on ${short} (run ${active.databaseId})`);
      await run(["gh", "run", "watch", String(active.databaseId), "--exit-status", "--interval", "3"], true);
      // Re-check rather than trust the exit code: the run may have been superseded or cancelled.
      const after = (await listRuns(sha)).find(r => r.databaseId === active.databaseId);
      if(after?.conclusion === "success") {
        log(`✓ CI passed on ${short}`);
        return;
      }
      throw new Error(`CI ${after?.conclusion || "didn't finish"} on ${short} (run ${active.databaseId}).`);
    }

    if(runs.length) throw new Error(`CI didn't pass on ${short} (${runs.map(r => r.conclusion).join(", ")}). Re-run or fix it, then try again.`);

    // No run yet: GitHub takes a few seconds to register a push.
    if(Date.now() - started > appearTimeoutMs) throw new Error(`No CI run appeared for ${short} within ${appearTimeoutMs / 1000}s. Is ${short} pushed?`);
    if(!announced) {
      log(`… Waiting for CI to start on ${short}`);
      announced = true;
    }
    await Bun.sleep(3000);
  }
}

if(import.meta.main) {
  const sha = process.argv[2] ?? (await run(["git", "rev-parse", "HEAD"])).out;
  try {
    await waitForCi(sha);
  } catch(e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
