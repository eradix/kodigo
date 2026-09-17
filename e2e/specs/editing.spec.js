import { Key } from "webdriverio";
import fs from "node:fs";
import path from "node:path";
import { VAULT_ROOT, readNote, writeNote } from "../vault.js";

/**
 * The interactive surface: opening notes, typing, saving, and the editor
 * commands. Assertions go to the filesystem wherever possible — what ends up in
 * the .md file is the only thing that actually matters to the person writing.
 */

/** Autosave is 600ms and the watcher debounce 300ms; this clears both. */
const SETTLE = 2000;

const editor = () => $(".cm-content");

/** Opens a note, expanding whatever folders stand between it and the root. */
async function openNote(rel) {
  const parts = rel.split("/");
  let folder = "";
  for (const part of parts.slice(0, -1)) {
    folder = folder ? `${folder}/${part}` : part;
    const row = await $(`[title="${folder}"]`);
    await row.waitForClickable();
    // Folders start collapsed, and clicking an open one would close it again.
    const chevron = await row.$(".chevron");
    const classes = (await chevron.getAttribute("class")) ?? "";
    if (!classes.includes("open")) {
      await row.click();
      await browser.pause(200);
    }
  }

  const row = await $(`[title="${rel}"]`);
  await row.waitForClickable();
  await row.click();
  await editor().waitForExist();
  // Give the document swap a moment to land before typing into it.
  await browser.pause(400);
}

/**
 * Puts the caret at the end of the note.
 *
 * The click is what gives the editor focus, and it has to come before Ctrl+End:
 * clicking afterwards would drop the caret wherever the pointer happened to be
 * and quietly undo the jump.
 */
async function focusEnd() {
  await editor().click();
  await browser.keys([Key.Ctrl, Key.End]);
}

/** Presses Enter. A newline inside browser.keys() is typed, not pressed. */
async function newLine() {
  await browser.keys(Key.Enter);
}

describe("opening a vault", () => {
  it("opens the vault it was given and lists its notes", async () => {
    // Report what actually rendered when this fails. A bare "element not found"
    // for the sidebar cannot distinguish a vault that failed to open from a
    // window that never came up at all, and the difference is the whole
    // diagnosis.
    await browser.waitUntil(async () => (await $$(".sidebar, .welcome")).length > 0, {
      timeout: 60_000,
      timeoutMsg: "neither the workspace nor the welcome screen appeared",
    });
    if (await $(".welcome").isExisting()) {
      throw new Error("the app started on the welcome screen: --vault was not honoured");
    }

    await expect($('[title="welcome.md"]')).toExist();
    await expect($('[title="second.md"]')).toExist();
  });

  it("opens a note when it is clicked", async () => {
    await openNote("welcome.md");
    expect(await editor().getText()).toContain("The first note.");

    const tab = await $('.tab[title="welcome.md"]');
    await expect(tab).toExist();
    // textContent rather than getText(): the label is clipped with
    // text-overflow, and WebKit's driver reports rendered text as empty for it.
    // The label is computed by displayName, which has its own unit tests.
    expect(await tab.$(".name").getProperty("textContent")).toBe("welcome");
  });

  it("reveals a note inside a folder", async () => {
    await openNote("projects/nested.md");
    expect(await editor().getText()).toContain("Inside a folder.");
  });
});

describe("typing and saving", () => {
  it("writes what was typed to the file on disk", async () => {
    await openNote("welcome.md");
    await focusEnd();
    await browser.keys("Typed by a test.");
    await browser.pause(SETTLE);

    expect(readNote("welcome.md")).toContain("Typed by a test.");
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
    await focusEnd();

    await browser.keys("FIRST");
    // Long enough for the save, and for any watcher echo to come back.
    await browser.pause(SETTLE);
    await browser.keys("SECOND");
    await browser.pause(SETTLE);

    const note = readNote("second.md");
    expect(note).toContain("FIRSTSECOND");
    expect(note.startsWith("SECOND")).toBe(false);
  });

  it("keeps each tab's own text when switching between them", async () => {
    await openNote("welcome.md");
    await focusEnd();
    await browser.keys("belongs-to-welcome");
    await browser.pause(SETTLE);

    await openNote("projects/nested.md");
    await focusEnd();
    await browser.keys("belongs-to-nested");
    await browser.pause(SETTLE);

    expect(readNote("welcome.md")).toContain("belongs-to-welcome");
    expect(readNote("welcome.md")).not.toContain("belongs-to-nested");
    expect(readNote("projects/nested.md")).toContain("belongs-to-nested");
  });
});

describe("editor commands", () => {
  it("wraps a selection in bold with Ctrl+B", async () => {
    await openNote("welcome.md");
    await focusEnd();
    await newLine();
    await browser.keys("plainword");
    // Select the word just typed, then bold it.
    for (let i = 0; i < "plainword".length; i++) {
      await browser.keys([Key.Shift, Key.ArrowLeft]);
    }
    await browser.keys([Key.Ctrl, "b"]);
    await browser.pause(SETTLE);

    expect(readNote("welcome.md")).toContain("**plainword**");
  });

  it("inserts a fenced block from the slash menu", async () => {
    await openNote("second.md");
    await focusEnd();
    // The menu only opens when the slash is the first thing on the line.
    await newLine();
    await browser.keys("/code");
    await browser.pause(700);
    await browser.keys(Key.Enter);
    await browser.pause(SETTLE);

    expect(readNote("second.md")).toContain("```");
  });
});

describe("changes made outside the app", () => {
  it("reloads a note that another program rewrote", async () => {
    await openNote("projects/nested.md");
    writeNote("projects/nested.md", "# Nested\n\nReplaced from outside.\n");
    await browser.waitUntil(
      async () => (await editor().getText()).includes("Replaced from outside."),
      {
        timeout: 20_000,
        timeoutMsg: "the editor never picked up the external rewrite",
      },
    );
  });
});

describe("scrolling", () => {
  /**
   * Reported twice from the app before it was reproducible here: the bottom of
   * a long note could not be reached. Two ways that happens, and this checks
   * both — the editor's own scroller refusing to move, and the window growing
   * past the viewport so the end is simply clipped off the screen.
   */
  it("reaches the bottom of a long note", async () => {
    await openNote("long.md");

    const layout = await browser.execute(() => {
      const scroller = document.querySelector(".cm-scroller");
      scroller.scrollTop = scroller.scrollHeight;
      return {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        // Anything above zero means the layout is taller than the window, and
        // body{overflow:hidden} is cutting the remainder off.
        pageOverflow: document.documentElement.scrollHeight - window.innerHeight,
        editorHostHeight: document.querySelector(".editor-host").clientHeight,
        windowHeight: window.innerHeight,
      };
    });

    expect(layout.pageOverflow).toBeLessThanOrEqual(1);
    expect(layout.editorHostHeight).toBeLessThanOrEqual(layout.windowHeight);
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight + 200);
    expect(layout.scrollTop).toBeGreaterThan(0);
  });

  it("keeps the sidebar list scrollable too", async () => {
    const layout = await browser.execute(() => {
      const body = document.querySelector(".sidebar-body");
      return {
        height: body.clientHeight,
        windowHeight: window.innerHeight,
      };
    });
    expect(layout.height).toBeLessThanOrEqual(layout.windowHeight);
  });
});

describe("creating notes and folders", () => {
  /**
   * The sidebar drops a new entry straight into an inline rename field.
   *
   * Typed through the keyboard rather than into an element handle: the tree
   * refreshes again when the watcher notices the new file, and a handle taken
   * before that goes stale. The field autofocuses with its stem selected, so
   * typing replaces the name and keeps the extension.
   */
  async function nameIt(name) {
    const selector = ".sidebar-body input.panel-input";
    await $(selector).waitForExist({ timeout: 10_000 });
    // Let the watcher's refresh land before typing into the field.
    await browser.pause(1200);
    await $(selector).waitForExist({ timeout: 10_000 });
    await browser.keys(name);
    await browser.keys(Key.Enter);
    await browser.pause(800);
  }

  it("creates a note from the sidebar button", async () => {
    await $('[title="New note"]').click();
    await nameIt("made-by-button");
    // Asserted against the listing rather than existsSync: a failure then names
    // what was actually written instead of only saying "false".
    expect(fs.readdirSync(VAULT_ROOT)).toContain("made-by-button.md");
  });

  /**
   * Added because creating a folder was reported as missing: it existed only
   * behind a right-click, and could not be reached at all in an empty vault.
   */
  it("creates a folder from the sidebar button", async () => {
    await $('[title="New folder"]').click();
    await nameIt("made-by-button-folder");
    expect(fs.readdirSync(VAULT_ROOT)).toContain("made-by-button-folder");
    expect(fs.statSync(path.join(VAULT_ROOT, "made-by-button-folder")).isDirectory()).toBe(true);
  });
});

describe("theme", () => {
  it("switches between dark and light, and repaints", async () => {
    const before = await browser.execute(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    expect(before.theme).toBe("dark");

    await $('[title="Switch to light theme"]').click();
    await browser.pause(400);

    const after = await browser.execute(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    expect(after.theme).toBe("light");
    // The attribute flipping is not enough; the tokens have to reach the page.
    expect(after.background).not.toBe(before.background);
    expect(after.background).toBe("rgb(255, 255, 255)");

    // Put it back so later runs of this file start from the documented default.
    await $('[title="Switch to dark theme"]').click();
    await browser.pause(300);
    expect(await browser.execute(() => document.documentElement.dataset.theme)).toBe("dark");
  });
});
