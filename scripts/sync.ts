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
//   bun run sync                 # back up + scan + push
//   bun run sync --force         # back up even if secretlint flags something
//   bun run restore              # restore files to ~ and run post steps
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
