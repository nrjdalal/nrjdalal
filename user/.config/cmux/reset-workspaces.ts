#!/usr/bin/env bun
// reset-workspaces.ts — nuke-and-pave my cmux sidebar in one shot.
//   bun ~/.config/cmux/reset-workspaces.ts              # do it
//   bun ~/.config/cmux/reset-workspaces.ts --dry-run    # preview, change nothing
//   bun ~/.config/cmux/reset-workspaces.ts --no-adopt   # don't reuse "this one" as a member
//
// Unlike workspaces.ts (additive, skips groups that exist), this fully rebuilds:
//   1. Keep the CURRENT workspace — "this one", the terminal you're running from.
//   2. Ungroup every group (keeps its workspaces), then close every OTHER workspace.
//   3. Recreate all GROUPS below from scratch: anchor + members, icon/color/pin/collapse.
// If the survivor's cwd matches a member, it's adopted into that group (no duplicate);
// otherwise it's left ungrouped and reported at the end.
// Scope: the current cmux window only.
import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run") || argv.includes("-n");
const ADOPT = !argv.includes("--no-adopt");
const HOME = homedir();

type Group = {
  name: string;
  cwd: string; // anchor workspace cwd = the group header (org/parent dir)
  members?: { title: string; cwd: string }[]; // project workspaces inside the group
  icon?: string; // SF Symbol
  color?: string; // #RRGGBB
  pinned?: boolean;
};

const GROUPS: Group[] = [
  {
    name: "lwai",
    cwd: join(HOME, "Desktop/lwai"),
    members: [{ title: "lwai", cwd: join(HOME, "Desktop/lwai/lwai") }],
    icon: "bolt.fill",
    color: "#f0883e",
    pinned: true,
  },
  {
    name: "nrjdalal",
    cwd: join(HOME, "Desktop/nrjdalal"),
    members: [{ title: "nrjdalal", cwd: join(HOME, "Desktop/nrjdalal/nrjdalal") }],
    icon: "person.fill",
    color: "#a371f7",
    pinned: true,
  },
  {
    name: "system",
    cwd: HOME,
    members: [
      { title: "Desktop", cwd: join(HOME, "Desktop") },
      { title: "Downloads", cwd: join(HOME, "Downloads") },
    ],
    icon: "gearshape.fill",
    color: "#3fb950",
    pinned: true,
  },
];

// ---- tiny helpers -----------------------------------------------------------

const say = (...a: unknown[]) => console.log(DRY ? "  [dry]" : "  ok  ", ...a);

// run a MUTATING cmux command; in --dry-run just print what would happen
async function run(args: string[]): Promise<void> {
  if (DRY) {
    console.log("        would run: cmux", args.join(" "));
    return;
  }
  await $`cmux ${args}`.quiet();
}

// run a mutating cmux command and return parsed JSON (stub {} in --dry-run)
async function runJson(args: string[]): Promise<any> {
  if (DRY) {
    console.log("        would run: cmux", args.join(" "));
    return {};
  }
  return await $`cmux ${args}`.json();
}

async function ensureDir(cwd: string): Promise<void> {
  if (DRY) return;
  await mkdir(cwd, { recursive: true });
}

const wsLabel = (w: { ref?: string; custom_title?: string | null; title?: string; current_directory?: string }) =>
  `${w.custom_title || w.title || "?"} (${w.ref}) @ ${w.current_directory}`;

// Every workspace opens with a single terminal.
async function createWorkspace(name: string, cwd: string): Promise<string | undefined> {
  await ensureDir(cwd);
  if (DRY) {
    console.log(`        would run: cmux workspace create --name ${name} --cwd ${cwd} --focus false`);
    return undefined;
  }
  const out = await $`cmux workspace create --name ${name} --cwd ${cwd} --focus false`.cwd(cwd).text();
  const ref = out.match(/workspace:\d+/)?.[0];
  if (!ref) throw new Error(`could not create workspace ${name} (${out})`);
  return ref;
}

// ---- 0. figure out "this one" ----------------------------------------------

const curLine = (await $`cmux --id-format both current-workspace`.text()).trim(); // "workspace:3 (UUID)"
const curUuid = curLine.match(/\(([0-9A-Fa-f-]{36})\)/)?.[1] ?? process.env.CMUX_WORKSPACE_ID;

const wsList: { workspaces: any[] } = await $`cmux --id-format both workspace list --json`.json();
const cur = wsList.workspaces.find((w) => w.id === curUuid) ?? wsList.workspaces.find((w) => w.selected);
if (!cur) throw new Error(`could not determine the current workspace (current-workspace said: ${curLine})`);

console.log(`\nkeeping "this one": ${wsLabel(cur)}\n`);

// ---- 1. teardown: ungroup everything, then close every OTHER workspace ------

console.log("teardown:");
const groups: any[] = (await $`cmux workspace-group list --json`.json().catch(() => ({ groups: [] }))).groups ?? [];
for (const g of groups) {
  say(`ungroup  ${g.name} (${g.ref})`);
  await run(["workspace-group", "ungroup", g.ref]);
}
for (const w of wsList.workspaces) {
  if (w.id === cur.id) continue; // never close the survivor
  say(`close    ${wsLabel(w)}`);
  await run(["close-workspace", "--workspace", w.id]);
}
console.log();

// ---- 2. rebuild: recreate all groups + member tabs from scratch -------------

console.log("rebuild:");
let adopted = false;

for (const g of GROUPS) {
  await ensureDir(g.cwd);

  // anchor-only group at the org-root dir (single terminal) — NON-dance, so it renders as a real group
  const created = await runJson(["workspace-group", "create", "--name", g.name, "--cwd", g.cwd, "--from", "", "--json"]);
  const gref: string = created.group?.ref ?? created.ref ?? "workspace_group:?";
  say(`group    ${g.name}  anchor@${g.cwd}  ${gref}`);

  // the layout-less anchor terminal inherits the caller's cwd (not --cwd), so force it; clear to keep it tidy
  const anchorWs: string | undefined = created.group?.anchor_workspace_ref;
  if (anchorWs) {
    await run(["send", "--workspace", anchorWs, "--", `cd ${g.cwd} && clear`]);
    await run(["send-key", "--workspace", anchorWs, "enter"]);
  }

  // project member workspaces: one terminal each
  for (const m of g.members ?? []) {
    const canAdopt = ADOPT && !adopted && cur.current_directory === m.cwd;
    if (canAdopt) {
      // reuse "this one" as this member instead of spawning a duplicate at the same cwd
      adopted = true;
      say(`adopt    this-one -> ${m.title}  (${m.cwd})`);
      await run(["rename-workspace", "--workspace", cur.id, m.title]);
      await run(["workspace-group", "add", "--group", gref, "--workspace", cur.id]);
      continue;
    }
    const ws = await createWorkspace(m.title, m.cwd);
    say(`member   ${m.title}  ${ws ?? "(dry)"}  ${m.cwd}`);
    if (ws) await run(["workspace-group", "add", "--group", gref, "--workspace", ws]);
  }

  if (g.icon) await run(["workspace-group", "set-icon", gref, "--symbol", g.icon]);
  if (g.color) await run(["workspace-group", "set-color", gref, "--hex", g.color]);
  if (g.pinned) await run(["workspace-group", "pin", gref]);
  await run(["workspace-group", "collapse", gref]); // collapsed so it reads as a group
}

console.log();
if (ADOPT && !adopted) {
  console.log(`note: "this one" (${cur.current_directory}) matched no member cwd — left ungrouped as a survivor.`);
}
console.log(DRY ? "dry-run complete — nothing changed." : "done.");
