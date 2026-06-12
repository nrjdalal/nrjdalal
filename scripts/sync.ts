#!/usr/bin/env bun
// sync.ts — back up local machine config into this repo (under user/, the $HOME
// mirror) and restore it onto a fresh machine. Driven by scripts/sync.json.
//
// Config (schema: scripts/sync.schema.json):
//   { "version": 1, "groups": {
//       "<group>": { "files": [<entry>...], "post"?: { "cmd": "...", "cwd"?: "..." } }
//   } }
//   <entry> = "rel/path"               under $HOME, mirrored to user/rel/path
//           | { "from": "...", "to": "..." }
//   pre  = { cmd, cwd? } run BEFORE backing up the group (e.g. capture a list);
//          cwd is relative to $HOME (default $HOME)
//   post = { cmd, cwd? } run AFTER restoring the group (e.g. regenerate/install);
//          cwd is relative to $HOME (default $HOME)
//
// Backup (default): run each group's pre.cmd, copy ~/<file> -> user/<file>, scan, push.
// Restore (--restore): copy user/<file> -> ~/<file>, then run each group's post.cmd.
//
// Usage:
//   bun run sync                 # back up + scan only (no git)
//   bun run sync --push          # back up + scan + commit + push
//   bun run sync --force         # back up even if secretlint flags something
//   bun run restore              # pick groups interactively, restore them + run post
//   bun run restore cmux git     # restore only the named groups, no prompt
//   bun run restore --all        # restore every group, no prompt
//   bun run restore --dry-run    # preview all groups, change nothing
import { $ } from "bun";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import readline from "node:readline";

const SCRIPT_DIR = import.meta.dir;
const REPO_ROOT = dirname(SCRIPT_DIR);
const HOME = homedir();
const MIRROR = "user"; // repo dir that mirrors $HOME
const args = new Set(process.argv.slice(2));

type Entry = string | { from?: string; to: string };
interface Group {
  files: Entry[];
  pre?: { cmd: string; cwd?: string };
  post?: { cmd: string; cwd?: string };
}
interface SyncConfig {
  version?: number;
  groups?: Record<string, Group>;
}

const config = (await Bun.file(join(SCRIPT_DIR, "sync.json")).json()) as SyncConfig;
const groups = Object.entries(config.groups ?? {});
const norm = (e: Entry) =>
  typeof e === "string" ? { from: e, to: e } : { from: e.from ?? e.to, to: e.to };
// aligned log prefix: fixed-width verb so the [group] column lines up
const tag = (verb: string, group: string) => `${verb.padEnd(8)}[${group}]`;

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const setRaw = (on: boolean) => {
  const s = process.stdin as any;
  if (s.isTTY && typeof s.setRawMode === "function") s.setRawMode(on);
};

// Arrow-key multi-select: ↑/↓ move, space toggle, enter confirm. Zero-dep
// (node:readline + raw mode). Adapted from nrjdalal/inscope's selectMany.
const selectMany = (
  message: string,
  choices: { label: string; value: string; checked?: boolean }[],
): Promise<string[]> =>
  new Promise((resolve) => {
    const checked = choices.map((c) => !!c.checked);
    const collect = () => choices.filter((_, i) => checked[i]).map((c) => c.value);
    if (!process.stdin.isTTY || choices.length === 0) {
      resolve(collect());
      return;
    }
    let idx = 0;
    const out = process.stdout;
    out.write(message + "\n");
    const render = (first: boolean) => {
      if (!first) out.write(`\x1b[${choices.length}A`);
      for (let i = 0; i < choices.length; i++) {
        const on = i === idx;
        const row = `${on ? "❯" : " "} ${checked[i] ? "◉" : "◯"} ${choices[i].label}`;
        out.write(`\x1b[2K  ${on ? CYAN + row + RESET : row}\n`);
      }
    };
    render(true);
    readline.emitKeypressEvents(process.stdin);
    setRaw(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      setRaw(false);
      process.stdin.pause();
    };
    const onKey = (s: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + choices.length) % choices.length;
        render(false);
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % choices.length;
        render(false);
      } else if (key.name === "space" || s === " ") {
        checked[idx] = !checked[idx];
        render(false);
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(collect());
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        out.write("\n");
        process.exit(130);
      }
    };
    process.stdin.on("keypress", onKey);
  });

if (args.has("--restore")) {
  await restore();
} else {
  await backup();
}

async function backup() {
  process.chdir(REPO_ROOT);
  const force = args.has("--force");
  const push = args.has("--push");

  const dests: string[] = [];
  for (const [group, g] of groups) {
    if (g.pre) {
      const cwd = join(HOME, g.pre.cwd ?? "");
      await mkdir(cwd, { recursive: true });
      console.log(`${tag("pre", group)} ${g.pre.cmd}`);
      const res = await $`sh -c ${g.pre.cmd}`.cwd(cwd).nothrow();
      process.stdout.write(res.stdout.toString());
      process.stderr.write(res.stderr.toString());
      if (res.exitCode !== 0) console.error(`⚠ [${group}] pre failed (exit ${res.exitCode})`);
    }
    for (const e of g.files) {
      const { from, to } = norm(e);
      const src = Bun.file(join(HOME, from));
      if (!(await src.exists())) {
        console.log(`${tag("skip", group)} ~/${from} (missing)`);
        continue;
      }
      const dest = join(MIRROR, to);
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, src);
      dests.push(dest);
      console.log(`${tag("backup", group)} ${dest}`);
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
      console.error("\n⚠ secretlint flagged the synced files — aborting. Redact, or rerun with --force.");
      process.exit(1);
    }
    console.error("\n--force given: continuing despite secretlint findings.");
  }

  // git only with --push; default leaves the working tree untouched for review
  if (!push) {
    console.log(`Copied ${dests.length} file(s) to ${MIRROR}/ — no git (pass --push to commit + push).`);
    return;
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
  const all = args.has("--all");

  const names = [...args].filter((a) => !a.startsWith("--")); // explicit group names

  let chosen = groups;
  if (names.length) {
    const unknown = names.filter((n) => !groups.some(([gn]) => gn === n));
    if (unknown.length) console.error(`unknown group(s): ${unknown.join(", ")}`);
    chosen = groups.filter(([n]) => names.includes(n));
    if (!chosen.length) {
      console.error("nothing to restore.");
      process.exit(1);
    }
  } else if (!dry && !all) {
    if (!process.stdin.isTTY) {
      console.error("restore needs group name(s), --all, or a terminal.");
      process.exit(1);
    }
    const picked = await selectMany(
      "Restore which?  (↑/↓ move · space toggle · enter confirm)",
      groups.map(([name]) => ({ label: name, value: name })),
    );
    if (picked.length === 0) {
      console.log("Nothing selected; aborted.");
      return;
    }
    chosen = groups.filter(([n]) => picked.includes(n));
  }

  for (const [group, g] of chosen) {
    let restoredAny = false;
    for (const e of g.files) {
      const { from, to } = norm(e);
      const repoPath = join(REPO_ROOT, MIRROR, to);
      if (!existsSync(repoPath)) {
        console.log(`${dry ? "[dry] " : ""}${tag("skip", group)} ${MIRROR}/${to} (not in repo)`);
        continue;
      }
      console.log(`${dry ? "[dry] " : ""}${tag("restore", group)} ~/${from}`);
      if (!dry) {
        const target = join(HOME, from);
        await mkdir(dirname(target), { recursive: true });
        await Bun.write(target, Bun.file(repoPath));
      }
      restoredAny = true;
    }
    if (restoredAny && g.post) {
      const cwd = join(HOME, g.post.cwd ?? "");
      console.log(`${dry ? "[dry] " : ""}${tag("post", group)} ${g.post.cmd}`);
      if (!dry) {
        const res = await $`sh -c ${g.post.cmd}`.cwd(cwd).nothrow();
        process.stdout.write(res.stdout.toString());
        process.stderr.write(res.stderr.toString());
        if (res.exitCode !== 0) console.error(`⚠ [${group}] post failed (exit ${res.exitCode})`);
      }
    }
  }
  console.log(dry ? "Dry run complete." : "Restore complete.");
}
