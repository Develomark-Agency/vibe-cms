import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { httpCaller } from "../../../actions/client.ts";
import { folderStore } from "../../../backups/fs.ts";
import { BackupError, planRestore, restoreSnapshot, unpackSnapshot, verifyRestore, type Progress } from "../../../backups/index.ts";
import { bytes, exportSite, formatElapsed } from "../../backups.ts";
import { useNav, useSession } from "../app.tsx";
import { resolvePath, type Field, type FormValues } from "../fields.ts";
import { copy, useSticky } from "../system.ts";
import { accent, Confirm, ErrorBox, Form, List, Spinner, TextInput, Title, useFlash, useHints, useKeys, useSize, type ListItem } from "../ui.tsx";

/** Where a long backup run is: per table, then files. */
interface Tally {
  tables: Record<string, { rows: number, total: number }>,
  files?: { done: number, total: number },
  retries: number,
  committing: boolean
}

function emptyTally(): Tally {
  return ({ tables: {}, retries: 0, committing: false });
}

function track(set: (update: (t: Tally) => Tally) => void) {
  return (p: Progress) => set(t => {
    if(p.step === "table") return { ...t, tables: { ...t.tables, [p.table]: { rows: p.rows, total: p.total } } };
    if(p.step === "file") return { ...t, files: { done: p.done, total: p.total } };
    if(p.step === "retry") return { ...t, retries: t.retries + 1 };
    return { ...t, committing: true };
  });
}

function Bar({ done, total, width = 24 }: { done: number, total: number, width?: number }) {
  const filled = total ? Math.round((Math.min(done, total) / total) * width) : width;
  return <Text><Text color={accent}>{"█".repeat(filled)}</Text><Text dimColor>{"░".repeat(width - filled)}</Text></Text>;
}

function TallyView({ tally, label }: { tally: Tally, label: string }) {
  return (
    <Box flexDirection="column">
      <Spinner label={label} />
      <Box flexDirection="column" marginTop={1}>
        {Object.entries(tally.tables).map(([table, { rows, total }]) => (
          <Text key={table}>{`  ${table.padEnd(10)} `}<Bar done={rows} total={total} /><Text dimColor>{`  ${rows}/${total}`}</Text></Text>
        ))}
        {tally.files ? <Text>{`  ${"files".padEnd(10)} `}<Bar done={tally.files.done} total={tally.files.total} /><Text dimColor>{`  ${tally.files.done}/${tally.files.total}`}</Text></Text> : null}
        {tally.committing ? <Text dimColor>  finishing…</Text> : null}
        {tally.retries ? <Text color="yellow">  ↻ {tally.retries} {tally.retries === 1 ? "transfer" : "transfers"} retried</Text> : null}
      </Box>
    </Box>
  );
}

function problemsOf(error: unknown): string[] {
  if(!(error instanceof BackupError)) return [];
  return (error.details as { details?: { problems?: string[] } } | undefined)?.details?.problems ?? [];
}

async function callerFor(session: ReturnType<typeof useSession>) {
  if(!session.site) throw new Error("Choose a site first");
  return httpCaller({ url: session.site.url, prefix: session.site.prefix, token: session.auth?.token });
}

const exportFields: Field[] = [
  { key: "file", label: "File name", kind: "string", required: false, placeholder: "<site>-<date>.vibe", description: "What to call the file" },
  { key: "dir", label: "Folder", kind: "string", required: false, placeholder: "this folder", description: "Where to write it" }
];

export function ExportScreen() {
  const session = useSession();
  const nav = useNav();
  const { width } = useSize();
  const [values, setValues] = useSticky<FormValues>("export", {});
  const [state, setState] = useState<"form" | "running" | "done" | "failed">("form");
  const [tally, setTally] = useState<Tally>(emptyTally);
  const [result, setResult] = useState<{ target: string, size: number, ms: number, counts: string, warnings: string[] }>();
  const [error, setError] = useState<{ message: string, problems: string[] }>();
  const [flash, setFlash] = useFlash();

  async function run() {
    setState("running");
    setTally(emptyTally());
    const started = performance.now();
    try {
      const dir = resolvePath(String(values.dir ?? "").trim() || ".");
      const file = String(values.file ?? "").trim() || undefined;
      const { target, taken, size } = await exportSite(await callerFor(session), file && !file.endsWith(".vibe") ? `${file}.vibe` : file, dir, track(setTally));
      const m = taken.manifest;
      setResult({ target, size, ms: performance.now() - started, counts: `${m.tables.documents} documents, ${m.tables.versions} versions, ${m.files.count} files`, warnings: taken.warnings });
      setState("done");
    } catch (e) {
      setError({ message: (e as Error).message, problems: problemsOf(e) });
      setState("failed");
    }
  }

  useHints(state === "running" ? [] : state === "form"
    ? [{ keys: "↑↓", label: "field" }, { keys: "⌃R", label: "export" }, { keys: "esc", label: "back" }]
    : [...result ? [{ keys: "c", label: "copy path" }] : [], { keys: "enter", label: "again" }, { keys: "esc", label: "back" }]);
  useKeys((input, key) => {
    if(state === "running") return;
    if(key.escape) nav.pop();
    else if(state !== "form" && key.return) setState("form");
    else if(state === "done" && input === "c" && result) setFlash(copy(result.target));
  });

  return (
    <Box flexDirection="column">
      <Title hint={session.site?.url}>Export the site</Title>
      {state === "form" ? <Form fields={exportFields} values={values} onChange={setValues} onSubmit={() => void run()} stickyKey="export" width={width} submitLabel="Export" /> : null}
      {state === "running" ? <TallyView tally={tally} label="Exporting…" /> : null}
      {state === "done" && result ? (
        <Box flexDirection="column">
          <Text><Text color="green" bold>✓ Exported </Text><Text color="cyan">{path.relative(process.cwd(), result.target) || result.target}</Text><Text dimColor>  {bytes(result.size)}, {formatElapsed(result.ms)}</Text></Text>
          <Text dimColor>  {result.counts}</Text>
          {result.warnings.map(w => <Text key={w} color="yellow">  ! {w}</Text>)}
        </Box>
      ) : null}
      {state === "failed" && error ? <ErrorBox title="Couldn't export" message={error.message}>{error.problems.map(p => <Text key={p}>• {p}</Text>)}</ErrorBox> : null}
      {flash ? <Text color="green">{flash}</Text> : null}
    </Box>
  );
}

type Plan = Awaited<ReturnType<typeof planRestore>>;

interface Loaded {
  file: string,
  work: string,
  store: ReturnType<typeof folderStore>,
  snapshot: string,
  plan: Plan
}

/** `.vibe` files in this folder, newest first. */
async function vibeFiles(): Promise<Array<{ name: string, size: number, at: Date }>> {
  const names = (await readdir(process.cwd()).catch(() => [] as string[])).filter(name => name.endsWith(".vibe"));
  const files = await Promise.all(names.map(async name => ({ name, ...await stat(name).then(s => ({ size: s.size, at: s.mtime })) })));
  return files.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function ImportScreen() {
  const session = useSession();
  const nav = useNav();
  const { height } = useSize();
  const [step, setStep] = useState<"pick" | "path" | "planning" | "plan" | "confirm" | "running" | "done" | "failed">("pick");
  const [files, setFiles] = useState<Array<{ name: string, size: number, at: Date }>>();
  const [typed, setTyped] = useSticky("import:path", "");
  const [loaded, setLoaded] = useState<Loaded>();
  const [safety, setSafety] = useState(true);
  const [force, setForce] = useState(false);
  const [tally, setTally] = useState<Tally>(emptyTally);
  const [phase, setPhase] = useState("");
  const [log, setLog] = useState<Array<{ text: string, color?: string }>>([]);
  const [error, setError] = useState<{ message: string, problems: string[] }>();
  const work = useRef<string>(undefined);

  useEffect(() => {
    void vibeFiles().then(found => {
      setFiles(found);
      if(!found.length) setStep("path");
    });
    return () => { if(work.current) void rm(work.current, { recursive: true, force: true }); };
  }, []);

  function fail(e: unknown) {
    setError({ message: (e as Error).message, problems: problemsOf(e) });
    setStep("failed");
  }

  async function load(file: string) {
    setStep("planning");
    try {
      const input = resolvePath(file);
      if(!(await stat(input).catch(() => null))?.isFile()) throw new BackupError(`No file at ${file}`);
      if(work.current) await rm(work.current, { recursive: true, force: true });
      work.current = await mkdtemp(path.join(tmpdir(), "vibe-import-"));
      const store = folderStore(work.current);
      const { path: snapshot } = await unpackSnapshot(Readable.toWeb(createReadStream(input)) as unknown as ReadableStream<Uint8Array>, store);
      const plan = await planRestore({ call: await callerFor(session), store, path: snapshot });
      setLoaded({ file: input, work: work.current, store, snapshot, plan });
      setStep("plan");
    } catch (e) {
      fail(e);
    }
  }

  async function run() {
    if(!loaded) return;
    setStep("running");
    const lines: Array<{ text: string, color?: string }> = [];
    try {
      const call = await callerFor(session);
      // An import that stopped part-way left the site as it was, and its export already exists.
      const status = await call("backups.restoreStatus", {}) as { restore: { from: { siteId: string, takenAt: number } } | null };
      const resuming = status.restore?.from.siteId === loaded.plan.snapshot.siteId && status.restore.from.takenAt === loaded.plan.snapshot.takenAt;
      if(safety && !resuming) {
        setPhase("Exporting the site as it is first…");
        setTally(emptyTally());
        const started = performance.now();
        const saved = await exportSite(call, undefined, path.dirname(loaded.file), track(setTally), "-before-import");
        lines.push({ text: `✓ Exported the site as it was first: ${path.relative(process.cwd(), saved.target) || saved.target} (${formatElapsed(performance.now() - started)})`, color: "green" });
        setLog([...lines]);
      }
      setPhase("Importing…");
      setTally(emptyTally());
      const started = performance.now();
      const result = await restoreSnapshot({ call, store: loaded.store, path: loaded.snapshot, force, onProgress: track(setTally) });
      setPhase("Checking the site against the file…");
      const verified = await verifyRestore({ call, store: loaded.store, path: loaded.snapshot });
      lines.push({ text: `✓ Imported${result.resumed ? " (resumed)" : ""}: ${result.files.uploaded} files uploaded, ${result.files.present} already there (${formatElapsed(performance.now() - started)})`, color: "green" });
      for(const warning of result.warnings) lines.push({ text: `! ${warning}`, color: "yellow" });
      if(!verified.ok) {
        lines.push({ text: "! The site doesn't match the file now (someone may have edited since):", color: "yellow" });
        for(const difference of verified.differences) lines.push({ text: `  ${difference}` });
      }
      setLog([...lines]);
      setStep("done");
      void session.reconnect();
    } catch (e) {
      setLog([...lines]);
      fail(e);
    }
  }

  useHints(
    step === "pick" ? [{ keys: "↑↓", label: "move" }, { keys: "enter", label: "choose" }, { keys: "esc", label: "back" }]
      : step === "path" ? [{ keys: "enter", label: "check it" }, { keys: "esc", label: "back" }]
        : step === "plan" ? [...loaded?.plan.check.ok ? [{ keys: "enter", label: "import" }, { keys: "s", label: "safety export" }, { keys: "f", label: "force" }] : [], { keys: "esc", label: "choose another" }]
          : step === "done" || step === "failed" ? [{ keys: "esc", label: "back" }]
            : []
  );
  useKeys((input, key) => {
    if(step === "pick" || step === "path") {
      if(key.escape) {
        if(step === "path" && files?.length) setStep("pick");
        else nav.pop();
      }
      return;
    }
    if(step === "plan") {
      if(key.escape) setStep(files?.length ? "pick" : "path");
      else if(!loaded?.plan.check.ok) return;
      else if(input === "s") setSafety(v => !v);
      else if(input === "f") setForce(v => !v);
      else if(key.return) setStep("confirm");
      return;
    }
    if((step === "done" || step === "failed") && key.escape) {
      // A file that couldn't be read or checked: pick another. Once the import started, there's nothing to go back to.
      if(step === "failed" && !log.length) setStep(files?.length ? "pick" : "path");
      else nav.pop();
    }
  });

  const items: ListItem[] = [
    ...(files ?? []).map(f => ({ id: f.name, label: f.name, hint: `${bytes(f.size)} · ${f.at.toLocaleString()}` })),
    { id: "other", label: "Another file…", color: "cyan" }
  ];
  const plan = loaded?.plan;

  return (
    <Box flexDirection="column">
      <Title hint={session.site ? `into ${session.site.url}` : undefined}>Import a .vibe file</Title>
      {step === "pick" ? (
        files ? <List items={items} height={Math.min(items.length, height - 3)} stickyKey="import:files" onSelect={item => item.id === "other" ? setStep("path") : void load(item.id)} /> : <Spinner label="Looking for .vibe files" />
      ) : null}
      {step === "path" ? (
        <Box>
          <Text>File  </Text>
          <TextInput value={typed} onChange={setTyped} placeholder="path/to/site.vibe" onSubmit={value => value.trim() && void load(value.trim())} />
        </Box>
      ) : null}
      {step === "planning" ? <Spinner label="Reading the file and checking it against the site…" /> : null}
      {plan && (step === "plan" || step === "confirm") ? (
        <Box flexDirection="column">
          <Text><Text bold>{path.basename(loaded!.file)}</Text><Text dimColor>  of {plan.snapshot.name ?? plan.snapshot.siteId}, taken {new Date(plan.snapshot.takenAt).toLocaleString()}</Text></Text>
          <Box flexDirection="column" marginY={1}>
            <Text dimColor>{"  ".padEnd(12)}{"now".padStart(8)}     after</Text>
            {Object.entries(plan.tables).map(([name, { now, after }]) => (
              <Text key={name}>{`  ${name.padEnd(10)}`}{String(now).padStart(8)}<Text dimColor>  →  </Text><Text color={after === now ? undefined : "yellow"}>{after}</Text></Text>
            ))}
            <Text>{`  ${"files".padEnd(10)}`}{String(plan.files.now.count).padStart(8)}<Text dimColor>  →  </Text>{plan.files.after.count}<Text dimColor> ({bytes(plan.files.after.bytes)})</Text></Text>
          </Box>
          {plan.check.warnings.map(w => <Text key={w} color="yellow">! {w}</Text>)}
          {plan.check.ok ? (
            <Box flexDirection="column" marginTop={1}>
              <Text><Text color={safety ? "green" : "yellow"}>{safety ? "◉" : "○"}</Text> Export the site as it is first <Text dimColor>(s)</Text></Text>
              <Text><Text color={force ? "yellow" : undefined}>{force ? "◉" : "○"}</Text> Replace another unfinished import <Text dimColor>(f)</Text></Text>
            </Box>
          ) : (
            <ErrorBox title="This file can't be imported into this site">{plan.check.problems.map(p => <Text key={p}>• {p}</Text>)}</ErrorBox>
          )}
          {step === "confirm" ? (
            <Box marginTop={1}>
              <Confirm danger message={`Replace ${session.site?.url}'s content with this file's?`} detail={safety ? "The site is exported next to the file first." : "Without a safety export, the content there now can't be got back."} yesLabel="Replace" onAnswer={yes => yes ? void run() : setStep("plan")} />
            </Box>
          ) : null}
        </Box>
      ) : null}
      {step === "running" ? <TallyView tally={tally} label={phase} /> : null}
      {log.length ? <Box flexDirection="column" marginTop={1}>{log.map((l, i) => <Text key={i} color={l.color}>{l.text}</Text>)}</Box> : null}
      {step === "failed" && error ? <ErrorBox title="Couldn't import" message={error.message}>{error.problems.map(p => <Text key={p}>• {p}</Text>)}</ErrorBox> : null}
    </Box>
  );
}
