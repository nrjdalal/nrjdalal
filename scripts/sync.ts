#!/usr/bin/env bun
// sync.ts — back up local machine config into this repo (under user/, the $HOME
// mirror) and restore it onto a fresh machine. Driven by scripts/sync.json.
//
// Config (schema: scripts/sync.schema.json):
//   { "version": 1, "groups": {
//       "<group>": { "files": [<entry>...], "run"?: "<cmd>", "cwd"?: "<dir>" }
//   } }
//   <entry> = "rel/path"               under $HOME, mirrored to user/rel/path
//           | { "from": "...", "to": "..." }
//   run = command run AFTER restoring the group (e.g. regenerate a derived file)
//   cwd = working dir for `run`, relative to $HOME (default $HOME)
//
// Backup (default): copy ~/<file> -> user/<file>, secretlint-scan, commit, push.
// Restore (--restore): copy user/<file> -> ~/<file>, then run each group's `run`.
//
// Usage:
//   bun run sync                 # back up + scan + push
//   bun run sync --force         # back up even if secretlint flags something
//   bun run restore              # restore files to ~ and run build steps
//   bun run restore --dry-run    # show what restore would do, change nothing
import { $ } from "bun";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const SCRIPT_DIR = import.meta.dir;
const REPO_ROOT = dirname(SCRIPT_DIR);
const HOME = homedir();
const MIRROR = "user"; // repo dir that mirrors $HOME
const args = new Set(process.argv.slice(2));

type Entry = string | { from?: string; to: string };
interface Group {
  files: Entry[];
  run?: string;
  cwd?: string;
}
interface SyncConfig {
  version?: number;
  groups?: Record<string, Group>;
}

const config = (await Bun.file(join(SCRIPT_DIR, "sync.json")).json()) as SyncConfig;
const groups = Object.entries(config.groups ?? {});
const norm = (e: Entry) =>
  typeof e === "string" ? { from: e, to: e } : { from: e.from ?? e.to, to: e.to };

if (args.has("--restore")) {
  await restore();
} else {
  await backup();
}

async function backup() {
  process.chdir(REPO_ROOT);
  const force = args.has("--force");

  const dests: string[] = [];
  for (const [group, g] of groups) {
    for (const e of g.files) {
      const { from, to } = norm(e);
      const src = Bun.file(join(HOME, from));
      if (!(await src.exists())) {
        console.log(`skip (missing): ~/${from}`);
        continue;
      }
      const dest = join(MIRROR, to);
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, src);
      dests.push(dest);
      console.log(`backed up [${group}]: ${dest}`);
    }
  }
  if (dests.length === 0) {
    console.log("Nothing to back up.");
    return;
  }

  // leak scan (secretlint)
  const secretlint = "node_modules/.bin/secretlint";
  if (!existsSync(secretlint)) {
    console.error("secretlint not found — run `bun install` first.");
    process.exit(1);
  }
  const scan = await $`${secretlint} ${dests}`.nothrow();
  process.stdout.write(scan.stdout.toString());
  process.stderr.write(scan.stderr.toString());
  if (scan.exitCode !== 0) {
    if (!force) {
      console.error("\n⚠ secretlint flagged the synced files — nothing committed. Redact, or rerun with --force.");
      process.exit(1);
    }
    console.error("\n--force given: continuing despite secretlint findings.");
  }

  // commit & push (scoped to our own dests)
  await $`git add -- ${dests}`;
  if ((await $`git diff --cached --name-only -- ${dests}`.text()).trim() === "") {
    console.log("No changes; nothing to commit.");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  await $`git commit -m ${`chore: sync config (${stamp})`} -- ${dests}`;
  await $`git push`;
  console.log(`Pushed to ${(await $`git remote get-url origin`.text()).trim()}`);
}

async function restore() {
  const dry = args.has("--dry-run");
  for (const [group, g] of groups) {
    let restoredAny = false;
    for (const e of g.files) {
      const { from, to } = norm(e);
      const repoPath = join(REPO_ROOT, MIRROR, to);
      if (!existsSync(repoPath)) {
        console.log(`skip (not in repo): ${MIRROR}/${to}`);
        continue;
      }
      console.log(`${dry ? "[dry] " : ""}restore [${group}]: ~/${from}`);
      if (!dry) {
        const target = join(HOME, from);
        await mkdir(dirname(target), { recursive: true });
        await Bun.write(target, Bun.file(repoPath));
      }
      restoredAny = true;
    }
    if (restoredAny && g.run) {
      const cwd = join(HOME, g.cwd ?? "");
      console.log(`${dry ? "[dry] " : ""}run     [${group}]: (~/${g.cwd ?? ""}) ${g.run}`);
      if (!dry) {
        const res = await $`sh -c ${g.run}`.cwd(cwd).nothrow();
        process.stdout.write(res.stdout.toString());
        process.stderr.write(res.stderr.toString());
        if (res.exitCode !== 0) console.error(`⚠ [${group}] run failed (exit ${res.exitCode})`);
      }
    }
  }
  console.log(dry ? "Dry run complete." : "Restore complete.");
}
