/**
 * `bun release --version x.x.x`: bumps packages/vibe-cms to that version, commits, tags `vX.Y.Z` and pushes.
 * The tag triggers .github/workflows/release.yml, which compiles the package (`bun run package`: the panel, then
 * tsdown into dist), smoke-tests it under Node and opens a *draft* GitHub release
 * for you to review and publish on GitHub.
 *
 * Flags: --version <x.y.z> (required), --no-push (commit and tag locally only),
 * --skip-ci-check (don't require a passing CI run on HEAD; the release workflow doesn't re-run the tests).
 */
import { parseArgs } from "node:util";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const pkgPath = path.join(root, "packages/vibe-cms/package.json");

const { values } = parseArgs({ options: { version: { type: "string" }, "no-push": { type: "boolean", default: false }, "skip-ci-check": { type: "boolean", default: false } } });

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function git(...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if(code) fail(`git ${args.join(" ")} failed: ${err.trim() || out.trim()}`);
  return out.trim();
}

const version = values.version;
if(!version) fail("Pass a version: bun release --version 1.2.3");
if(!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`"${version}" isn't a valid semver (like 1.2.3 or 1.2.3-rc.1).`);

const pkg = JSON.parse(await Bun.file(pkgPath).text());
if(Bun.semver.order(version, pkg.version) !== 1) fail(`${version} must be greater than the current version, ${pkg.version}.`);

const tag = `v${version}`;
if(await git("status", "--porcelain")) fail("The working tree has uncommitted changes. Commit or stash them first.");
if(await git("tag", "--list", tag)) fail(`Tag ${tag} already exists.`);
const branch = await git("branch", "--show-current");
if(!branch) fail("Not on a branch (detached HEAD).");

// The release workflow doesn't re-run typecheck and tests, so make sure CI passed on the commit being released.
if(!values["skip-ci-check"]) {
  const sha = await git("rev-parse", "HEAD");
  const proc = Bun.spawn(["gh", "run", "list", "--workflow", "ci.yml", "--commit", sha, "--json", "conclusion", "--jq", "map(.conclusion) | join(\",\")"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if(code) fail(`Couldn't check CI with gh (${err.trim() || `exit ${code}`}). Fix that or pass --skip-ci-check.`);
  if(!out.trim().split(",").includes("success")) fail(`CI hasn't passed on ${sha.slice(0, 7)} (got: ${out.trim() || "no runs"}). Push it and wait for CI, or pass --skip-ci-check.`);
}

pkg.version = version;
await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
await git("add", pkgPath);
await git("commit", "-m", `Release ${version}`);
await git("tag", "-a", tag, "-m", `Release ${version}`);
console.log(`✓ Committed and tagged ${tag} on ${branch}`);

if(values["no-push"]) {
  console.log(`Not pushed. When ready: git push origin ${branch} ${tag}`);
} else {
  await git("push", "origin", branch, tag);
  console.log("✓ Pushed. The workflow is building a draft release: https://github.com/jclarkDM/vibe-cms/releases");
}
