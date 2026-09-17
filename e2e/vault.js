import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The throwaway vault and data directory a test run works against.
 *
 * The paths are fixed rather than randomised because this module is loaded by
 * both the WebdriverIO launcher and its worker processes, and the two have to
 * agree: the launcher puts them on the app's command line, the specs read the
 * notes back off disk. A directory randomised per process would leave the specs
 * inspecting a vault the app had never opened. The cost is that two runs on one
 * machine would collide, which nothing here needs to do.
 *
 * The data directory is the safety-critical half. Passing it as --data-dir keeps
 * the recents list and the search index out of the real profile, so a run cannot
 * see, corrupt or delete the notes of whoever is running the tests.
 */
export const BASE = path.join(os.tmpdir(), "kodigo-e2e-run");
export const VAULT_ROOT = path.join(BASE, "vault");
export const DATA_DIR = path.join(BASE, "data");

// A note far taller than any window, used to check that the editor can be
// scrolled all the way down.
const LONG_NOTE =
  "# Long note\n\n" +
  Array.from({ length: 300 }, (_, i) => `Line ${i + 1} of a very long note.`).join("\n") +
  "\n\nTHE-VERY-LAST-LINE\n";

// Laid out so the caret can be put on an exact line by counting from the top.
// 1 heading, 3 paragraph, 5-7 fenced block, 9 colour tag, 11 last line.
const PREVIEW_NOTE = [
  "# Heading one",
  "",
  "Plain paragraph text.",
  "",
  "```js",
  "const answer = 1;",
  "```",
  "",
  '## <font color="green">Sept 16, 2026</font>',
  "",
  "Last plain line.",
  "",
].join("\n");

const NOTES = {
  "preview.md": PREVIEW_NOTE,
  "welcome.md": "# Welcome\n\nThe first note.\n",
  "second.md": "# Second\n\nAnother note entirely.\n",
  "projects/nested.md": "# Nested\n\nInside a folder.\n",
  "long.md": LONG_NOTE,
};

/**
 * Rebuilds the vault from scratch. Only the launcher calls this — a worker
 * doing so would wipe the notes out from under a running test.
 */
export function resetVault() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(VAULT_ROOT, "projects"), { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [rel, body] of Object.entries(NOTES)) {
    fs.writeFileSync(path.join(VAULT_ROOT, rel), body);
  }
}

export function removeVault() {
  fs.rmSync(BASE, { recursive: true, force: true });
}

export function readNote(rel) {
  return fs.readFileSync(path.join(VAULT_ROOT, rel), "utf8");
}

export function writeNote(rel, body) {
  fs.writeFileSync(path.join(VAULT_ROOT, rel), body);
}
