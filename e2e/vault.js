import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway vault plus a throwaway app-data directory for one test run.
 *
 * The app-data directory is the important half. Kodigo keeps its recent-vault
 * list and its index under `$XDG_DATA_HOME`, so pointing that at a temporary
 * directory means a test run cannot see, corrupt or delete the notes and index
 * belonging to whoever is running the tests.
 */
export function createVault() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-e2e-"));
  const root = path.join(base, "vault");
  const dataDir = path.join(base, "data");
  fs.mkdirSync(path.join(root, "projects"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const notes = {
    "welcome.md": "# Welcome\n\nThe first note.\n",
    "second.md": "# Second\n\nAnother note entirely.\n",
    "projects/nested.md": "# Nested\n\nInside a folder.\n",
  };
  for (const [rel, body] of Object.entries(notes)) {
    fs.writeFileSync(path.join(root, rel), body);
  }

  // Kodigo reopens the most recent vault on launch, so seeding this file is how
  // a test gets a vault open without driving the folder picker, which is an OS
  // dialog and outside the webview's reach.
  fs.mkdirSync(path.join(dataDir, "com.kodigo.app"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "com.kodigo.app", "recent-vaults.json"),
    JSON.stringify([{ path: root, name: "vault" }], null, 2),
  );

  return { base, root, dataDir };
}

/**
 * Where the launcher records the vault it made. Spec files run in separate
 * worker processes, so a pointer file is a surer channel than an env var that
 * has to survive a fork.
 */
export const POINTER = path.join(os.tmpdir(), "kodigo-e2e-current.json");

export function publishVault(vault) {
  fs.writeFileSync(POINTER, JSON.stringify(vault));
}

/** The vault the running suite is working against. */
export function currentVault() {
  return JSON.parse(fs.readFileSync(POINTER, "utf8"));
}

export function readNote(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

export function writeNote(root, rel, body) {
  fs.writeFileSync(path.join(root, rel), body);
}

export function removeVault(base) {
  fs.rmSync(base, { recursive: true, force: true });
}
