#!/usr/bin/env bun
// workspaces.ts — create my cmux workspace GROUPS in one shot.
//   bun ~/.config/cmux/workspaces.ts
// Each group's anchor is the org/parent dir; members are the project workspaces.
// Every workspace opens with the Default 80/20 (4:1) vertical two-terminal split.
// Re-runnable: skips a group whose name already exists.
import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const HOME = homedir();

// the "Default thingy": vertical 80/20 split, two terminals at the same cwd
const layoutFor = (cwd: string) => ({
  direction: "vertical",
  split: 0.8,
  children: [
    { pane: { surfaces: [{ type: "terminal", cwd, focus: true }] } },
    { pane: { surfaces: [{ type: "terminal", cwd }] } },
  ],
});

async function createWorkspace(name: string, cwd: string): Promise<string> {
  await mkdir(cwd, { recursive: true }); // ensure the dir exists (fresh machine)
  const out = await $`cmux workspace create --name ${name} --cwd ${cwd} --layout ${JSON.stringify(layoutFor(cwd))} --focus false`.cwd(cwd).text();
  const ref = out.match(/workspace:\d+/)?.[0];
  if (!ref) throw new Error(`could not create workspace ${name} (${out})`);
  return ref;
}

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

const listed = await $`cmux workspace-group list --json`.json().catch(() => ({ groups: [] }));
const existing = new Set((listed.groups ?? []).map((g: { name?: string }) => g.name).filter(Boolean));

for (const g of GROUPS) {
  if (existing.has(g.name)) {
    console.log(`skip    ${g.name} (group exists)`);
    continue;
  }

  // anchor-only group at the org-root dir (single terminal) — NON-dance, so it renders as a real group
  await mkdir(g.cwd, { recursive: true }); // ensure the org-root dir exists
  const created = await $`cmux ${["workspace-group", "create", "--name", g.name, "--cwd", g.cwd, "--from", "", "--json"]}`.cwd(g.cwd).json();
  const gref: string = created.group?.ref ?? created.ref;

  // the layout-less anchor terminal inherits the caller's cwd (not --cwd), so force it; clear to keep it tidy
  const anchorWs: string | undefined = created.group?.anchor_workspace_ref;
  if (anchorWs) {
    await $`cmux send --workspace ${anchorWs} -- ${`cd ${g.cwd} && clear`}`.quiet();
    await $`cmux send-key --workspace ${anchorWs} enter`.quiet();
  }

  // project member workspaces get the Default 80/20 split
  const memberRefs: string[] = [];
  for (const m of g.members ?? []) {
    const ws = await createWorkspace(m.title, m.cwd);
    await $`cmux workspace-group add --group ${gref} --workspace ${ws}`.quiet();
    memberRefs.push(ws);
  }

  if (g.icon) await $`cmux workspace-group set-icon ${gref} --symbol ${g.icon}`.quiet();
  if (g.color) await $`cmux workspace-group set-color ${gref} --hex ${g.color}`.quiet();
  if (g.pinned) await $`cmux workspace-group pin ${gref}`.quiet();
  await $`cmux workspace-group collapse ${gref}`.quiet(); // collapsed so it reads as a group

  console.log(`group   ${g.name}  anchor@${g.cwd} (1 term)  members=[${memberRefs.join(",")}] (80/20)  ${gref}`);
}
console.log("done.");
