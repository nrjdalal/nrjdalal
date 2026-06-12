#!/usr/bin/env bun
// sync.ts — mirror local machine config into this repo under user/ (which stands
// in for $HOME), scan for leaked secrets with secretlint, then commit and push.
//
// Driven by sync.json at the repo root (schema: schemas/sync.json):
//   { "version": 1, "groups": { "<group>": [ <entry>, ... ] } }
// where <entry> is either
//   "rel/path"                       copy ~/rel/path -> user/rel/path
//   { "from": "...", "to": "..." }    copy ~/from -> user/to  (from defaults to to)
//   { "cmd": "...", "to": "..." }     write the command's stdout -> user/to
//
// secretlint (vendored devDependency; config in package.json) scans the synced
// files before committing; on a finding the sync aborts. Pass --force to override.
//
// Usage:
//   bun install            # once, to vendor secretlint
//   bun run sync           # sync all groups, scan, commit, push
//   bun run sync --force   # commit even if secretlint flags something
import { $ } from "bun";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

process.chdir(dirname(import.meta.dir)); // repo root (this file lives in scripts/)
const HOME = homedir();
const MIRROR = "user"; // repo dir that mirrors $HOME
const force = process.argv.includes("--force");

type Entry = string | { from?: string; to: string; cmd?: string };
interface SyncConfig {
  version?: number;
  groups?: Record<string, Entry[]>;
}

const CONFIG_FILE = "sync.json";
if (!existsSync(CONFIG_FILE)) {
  console.error(`${CONFIG_FILE} not found at repo root.`);
  process.exit(1);
}
const config = (await Bun.file(CONFIG_FILE).json()) as SyncConfig;
const groups = config.groups ?? {};

const dests: string[] = [];
for (const [group, entries] of Object.entries(groups)) {
  for (const raw of entries) {
    const entry = typeof raw === "string" ? { to: raw } : raw;
    const dest = join(MIRROR, entry.to); // repo path under user/
    await mkdir(dirname(dest), { recursive: true });

    if (entry.cmd) {
      const out = await $`sh -c ${entry.cmd}`.nothrow();
      if (out.exitCode !== 0) {
        console.log(`skip (cmd failed): ${dest}`);
        continue;
      }
      await Bun.write(dest, out.stdout);
      dests.push(dest);
      console.log(`synced [${group}]: ${dest} (cmd)`);
      continue;
    }

    const from = entry.from ?? entry.to;
    const file = Bun.file(join(HOME, from));
    if (!(await file.exists())) {
      console.log(`skip (missing): ~/${from}`);
      continue;
    }
    await Bun.write(dest, file);
    dests.push(dest);
    console.log(`synced [${group}]: ${dest}`);
  }
}

if (dests.length === 0) {
  console.log("Nothing synced.");
  process.exit(0);
}

// --- leak scan (secretlint) ------------------------------------------------
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

// --- commit & push ---------------------------------------------------------
await $`git add -- ${dests}`;
// scope the change-check and commit to our own files, so unrelated staged
// changes are never swept into a sync commit
if ((await $`git diff --cached --name-only -- ${dests}`.text()).trim() === "") {
  console.log("No changes; nothing to commit.");
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
await $`git commit -m ${`chore: sync config (${stamp})`} -- ${dests}`;
await $`git push`;
console.log(`Pushed to ${(await $`git remote get-url origin`.text()).trim()}`);
