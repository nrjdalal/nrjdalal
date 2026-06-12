#!/usr/bin/env bun
// sync-configs.ts — mirror local machine config into this repo, scan for leaked
// secrets with secretlint, then commit and push.
//
// CONFIGS maps a group key to paths relative to BOTH $HOME and the repo root,
// e.g. ".config/cmux/cmux.json" copies ~/.config/cmux/cmux.json -> .config/cmux/cmux.json.
//
// Before committing, the synced files are scanned with secretlint (vendored as a
// devDependency — run `bun install` first; config lives in package.json's
// "secretlint" field) so nothing personal gets pushed by accident. On a finding
// the sync aborts; pass --force to override a reviewed false positive.
//
// Usage:
//   bun install            # once, to vendor secretlint
//   bun run sync           # sync all groups, scan, commit, push
//   bun run sync --force   # commit even if secretlint flags something
import { $ } from "bun";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

process.chdir(dirname(import.meta.dir)); // repo root (this file lives in scripts/)
const HOME = homedir();
const force = process.argv.includes("--force");

// group -> paths relative to $HOME (and to the repo root)
const CONFIGS: Record<string, string[]> = {
  cmux: [".config/cmux/cmux.json", ".config/cmux/settings.json"],
};

const dests: string[] = [];
for (const [group, paths] of Object.entries(CONFIGS)) {
  for (const rel of paths) {
    const file = Bun.file(`${HOME}/${rel}`);
    if (!(await file.exists())) {
      console.log(`skip (missing): ${rel}`);
      continue;
    }
    await mkdir(dirname(rel), { recursive: true });
    await Bun.write(rel, file);
    dests.push(rel);
    console.log(`synced [${group}]: ${rel}`);
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
if ((await $`git diff --cached --name-only`.text()).trim() === "") {
  console.log("No changes; nothing to commit.");
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
await $`git commit -m ${`chore: sync config (${stamp})`}`;
await $`git push`;
console.log(`Pushed to ${(await $`git remote get-url origin`.text()).trim()}`);
