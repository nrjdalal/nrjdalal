#!/usr/bin/env bun
// sync.ts — mirror local machine config into this repo, commit, and push.
//
// HOME_FILES: files under $HOME, copied to the SAME relative path in the repo
//   (e.g. ~/.config/cmux/cmux.json -> .config/cmux/cmux.json).
// GENERATED:  [command, repo-relative dest] — command stdout written to dest.
// Only the resulting paths are staged; unrelated changes are left alone.
//
// Usage: ./sync.ts   (or: bun sync.ts)
import { $ } from "bun";
import { homedir } from "node:os";
import { dirname, relative } from "node:path";
import { mkdir } from "node:fs/promises";

process.chdir(import.meta.dir);
const HOME = homedir();

const HOME_FILES: string[] = [
  `${HOME}/.config/cmux/cmux.json`,
];

const GENERATED: [string, string][] = [
  // ["code --list-extensions", "vscode-extensions.txt"],
];

const dests: string[] = [];

for (const src of HOME_FILES) {
  if (!src.startsWith(`${HOME}/`)) {
    console.log(`skip (not under $HOME): ${src}`);
    continue;
  }
  const dest = relative(HOME, src);
  const file = Bun.file(src);
  if (!(await file.exists())) {
    console.log(`skip (missing): ${src}`);
    continue;
  }
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, file);
  dests.push(dest);
  console.log(`synced: ${dest}`);
}

for (const [cmd, dest] of GENERATED) {
  await mkdir(dirname(dest), { recursive: true });
  try {
    const out = await $`sh -c ${cmd}`.text();
    await Bun.write(dest, out);
    dests.push(dest);
    console.log(`synced: ${dest}`);
  } catch {
    console.log(`skip (command failed): ${cmd}`);
  }
}

if (dests.length === 0) {
  console.log("Nothing synced.");
  process.exit(0);
}

await $`git add -- ${dests}`;
if ((await $`git diff --cached --name-only`.text()).trim() === "") {
  console.log("No changes; nothing to commit.");
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
await $`git commit -m ${`chore: sync config (${stamp})`}`;
await $`git push`;
console.log(`Pushed to ${(await $`git remote get-url origin`.text()).trim()}`);
