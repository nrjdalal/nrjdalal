#!/usr/bin/env bun
// sync-configs.ts — mirror local machine config into this repo, scan for leaked
// secrets, then commit and push.
//
// CONFIGS maps a group key to paths relative to BOTH $HOME and the repo root,
// e.g. ".config/cmux/cmux.json" copies ~/.config/cmux/cmux.json -> .config/cmux/cmux.json.
//
// Before anything is committed, every synced file is scanned for secrets/keys so
// nothing personal gets pushed by accident. If something matches, the sync aborts
// and nothing is committed. Pass --force to override a (reviewed) false positive.
//
// Usage:
//   bun run sync          # sync all groups, scan, commit, push
//   bun run sync --force  # commit even if the scanner flags something
import { $ } from "bun";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

process.chdir(dirname(import.meta.dir)); // repo root (this file lives in scripts/)
const HOME = homedir();
const force = process.argv.includes("--force");

// group -> paths relative to $HOME (and to the repo root)
const CONFIGS: Record<string, string[]> = {
  cmux: [".config/cmux/cmux.json", ".config/cmux/settings.json"],
};

// Leak detector: anything matching these must never be pushed.
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "OpenAI/Anthropic key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    name: "assigned secret",
    re: /["']?\w*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)\w*["']?\s*[:=]\s*["']([^"'\s]{6,})["']/i,
  },
];
const PLACEHOLDER = /^(?:x+|\*+|changeme|placeholder|your[-_].*|<.*>)$/i;

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

// --- leak scan -------------------------------------------------------------
const findings: { file: string; line: number; rule: string }[] = [];
for (const rel of dests) {
  const lines = (await Bun.file(rel).text()).split("\n");
  lines.forEach((line, i) => {
    for (const { name, re } of SECRET_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      if (name === "assigned secret" && m[1] && PLACEHOLDER.test(m[1])) continue;
      findings.push({ file: rel, line: i + 1, rule: name });
      break;
    }
  });
}

if (findings.length > 0) {
  console.error(
    `\n⚠ Leak detector flagged ${findings.length} item(s) — open the file(s) and review:`,
  );
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
  if (!force) {
    console.error("\nNothing committed. Redact, or rerun with --force if it's a false positive.");
    process.exit(1);
  }
  console.error("\n--force given: continuing despite the matches above.");
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
