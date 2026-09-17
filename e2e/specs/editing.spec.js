import { Key } from "webdriverio";
import { currentVault, readNote, writeNote } from "../vault.js";

/**
 * The interactive surface: opening notes, typing, saving, and the editor
 * commands. Assertions go to the filesystem wherever possible — what ends up in
 * the .md file is the only thing that actually matters to the person writing.
 */

const { root } = currentVault();

/** Autosave is 600ms and the watcher debounce 300ms; this clears both. */
const SETTLE = 2000;

const editor = () => $(".cm-content");

async function openNote(rel) {
  const row = await $(`[title="${rel}"]`);
  await row.waitForClickable();
  await row.click();
  await editor().waitForExist();
  // Give the document swap a moment to land before typing into it.
  await browser.pause(400);
}

async function type(text) {
  await editor().click();
  await browser.keys(text);
}

describe("opening a vault", () => {
  it("opens the vault it was given and lists its notes", async () => {
    // Report what actually rendered when this fails. A bare "element not found"
    // for the sidebar cannot distinguish a vault that failed to open from a
    // window that never came up at all, and the difference is the whole
    // diagnosis.
    await browser.waitUntil(
      async () => (await $$(".sidebar, .welcome")).length > 0,
      { timeout: 60_000, timeoutMsg: "neither the workspace nor the welcome screen appeared" },
    );
    const welcome = await $(".welcome");
    if (await welcome.isExisting()) {
      throw new Error("the app started on the welcome screen: --vault was not honoured");
    }

    await expect($('[title="welcome.md"]')).toExist();
    await expect($('[title="second.md"]')).toExist();
  });

  it("opens a note when it is clicked", async () => {
    await openNote("welcome.md");
    await expect(editor()).toHaveTextContaining("The first note.");
    await expect($(".tab .name")).toHaveText("welcome");
  });
});

describe("typing and saving", () => {
  it("writes what was typed to the file on disk", async () => {
    await openNote("welcome.md");
    await browser.keys([Key.Ctrl, Key.End]);
    await type(" Typed by a test.");
    await browser.pause(SETTLE);

    expect(readNote(root, "welcome.md")).toContain("Typed by a test.");
  });

  /**
   * The regression that shipped: autosave triggered the file watcher, the
   * watcher reported the app's own write back as an external edit, and the
   * editor rebuilt itself — sending the caret to offset zero mid-sentence.
   *
   * If that ever returns, the second burst of typing lands at the top of the
   * document and this assertion fails.
   */
  it("leaves the caret alone when autosave fires", async () => {
    await openNote("second.md");
    await browser.keys([Key.Ctrl, Key.End]);

    await type("FIRST");
    // Long enough for the save, and for any watcher echo to come back.
    await browser.pause(SETTLE);
    await browser.keys("SECOND");
    await browser.pause(SETTLE);

    const note = readNote(root, "second.md");
    expect(note).toContain("FIRSTSECOND");
    expect(note.startsWith("SECOND")).toBe(false);
  });

  it("keeps each tab's own text when switching between them", async () => {
    await openNote("welcome.md");
    await browser.keys([Key.Ctrl, Key.End]);
    await type(" belongs-to-welcome");
    await browser.pause(SETTLE);

    await openNote("projects/nested.md");
    await browser.keys([Key.Ctrl, Key.End]);
    await type(" belongs-to-nested");
    await browser.pause(SETTLE);

    expect(readNote(root, "welcome.md")).toContain("belongs-to-welcome");
    expect(readNote(root, "welcome.md")).not.toContain("belongs-to-nested");
    expect(readNote(root, "projects/nested.md")).toContain("belongs-to-nested");
  });
});

describe("editor commands", () => {
  it("wraps a selection in bold with Ctrl+B", async () => {
    await openNote("welcome.md");
    await browser.keys([Key.Ctrl, Key.End]);
    await type("\nplainword");
    // Select the word just typed, then bold it.
    for (let i = 0; i < "plainword".length; i++) {
      await browser.keys([Key.Shift, Key.ArrowLeft]);
    }
    await browser.keys([Key.Ctrl, "b"]);
    await browser.pause(SETTLE);

    expect(readNote(root, "welcome.md")).toContain("**plainword**");
  });

  it("inserts a fenced block from the slash menu", async () => {
    await openNote("second.md");
    await browser.keys([Key.Ctrl, Key.End]);
    await type("\n/code");
    // Let the completion list appear before accepting it.
    await browser.pause(700);
    await browser.keys(Key.Enter);
    await browser.pause(SETTLE);

    expect(readNote(root, "second.md")).toContain("```");
  });
});

describe("changes made outside the app", () => {
  it("reloads a note that another program rewrote", async () => {
    await openNote("projects/nested.md");
    writeNote(root, "projects/nested.md", "# Nested\n\nReplaced from outside.\n");
    await browser.waitUntil(
      async () => (await editor().getText()).includes("Replaced from outside."),
      {
        timeout: 20_000,
        timeoutMsg: "the editor never picked up the external rewrite",
      },
    );
  });
});
