import { EditorSelection, EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  insertCodeBlock,
  insertLink,
  setHeading,
  toggleBold,
  toggleBullet,
  toggleInlineCode,
  toggleQuote,
  toggleTask,
  FormatCommand,
} from "./shortcuts";

/**
 * The formatting commands only ever read `view.state` and call `view.dispatch`,
 * so a stub standing in for the view keeps these tests free of the DOM.
 */
function run(command: FormatCommand, doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: (TransactionSpec | Transaction)[]) {
      for (const spec of specs) {
        state = (spec as Transaction).state
          ? (spec as Transaction).state
          : state.update(spec as TransactionSpec).state;
      }
    },
  } as unknown as EditorView;

  command(view);
  return {
    doc: view.state.doc.toString(),
    selection: view.state.selection.main,
  };
}

/** Position of `|` in a template, with the marker stripped out. */
function at(template: string): [string, number] {
  return [template.replace("|", ""), template.indexOf("|")];
}

describe("wrapping commands", () => {
  it("wraps a selection and keeps it selected", () => {
    const result = run(toggleBold, "hello world", 6, 11);
    expect(result.doc).toBe("hello **world**");
    expect(result.doc.slice(result.selection.from, result.selection.to)).toBe("world");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const result = run(toggleBold, "hello **world**", 8, 13);
    expect(result.doc).toBe("hello world");
    expect(result.doc.slice(result.selection.from, result.selection.to)).toBe("world");
  });

  it("unwraps when the markers are inside the selection", () => {
    const result = run(toggleBold, "hello **world**", 6, 15);
    expect(result.doc).toBe("hello world");
  });

  it("leaves the cursor between the markers when nothing is selected", () => {
    const [doc, pos] = at("hello |");
    const result = run(toggleInlineCode, doc, pos);
    expect(result.doc).toBe("hello ``");
    expect(result.selection.head).toBe(7);
    expect(result.selection.empty).toBe(true);
  });
});

describe("line commands", () => {
  it("adds a heading prefix and replaces an existing one", () => {
    expect(run(setHeading(2), "Title", 0).doc).toBe("## Title");
    expect(run(setHeading(2), "# Title", 0).doc).toBe("## Title");
  });

  it("removes the prefix when the line is already at that level", () => {
    expect(run(setHeading(2), "## Title", 0).doc).toBe("Title");
  });

  it("applies to every line the selection touches", () => {
    const result = run(setHeading(1), "one\ntwo\nthree", 0, 9);
    expect(result.doc).toBe("# one\n# two\n# three");
  });

  it("toggles a quote prefix", () => {
    expect(run(toggleQuote, "note", 0).doc).toBe("> note");
    expect(run(toggleQuote, "> note", 0).doc).toBe("note");
  });
});

describe("insertions", () => {
  it("fences the selected lines and parks the cursor on the info string", () => {
    const result = run(insertCodeBlock, "let x = 1;", 0, 10);
    expect(result.doc).toBe("```\nlet x = 1;\n```");
    // Right after the opening backticks, so a language can be typed immediately.
    expect(result.selection.head).toBe(3);
  });

  it("fences an empty line without swallowing neighbours", () => {
    const [doc, pos] = at("before\n|\nafter");
    const result = run(insertCodeBlock, doc, pos);
    expect(result.doc).toBe("before\n```\n\n```\nafter");
  });

  it("turns a selection into link text and waits in the URL", () => {
    const result = run(insertLink, "see the docs", 8, 12);
    expect(result.doc).toBe("see the [docs]()");
    expect(result.selection.head).toBe(result.doc.length - 1);
  });
});

describe("list markers", () => {
  it("converts a bullet into a task instead of stacking markers", () => {
    expect(run(toggleTask, "- buy milk", 0).doc).toBe("- [ ] buy milk");
  });

  it("converts a task back into a plain bullet", () => {
    expect(run(toggleBullet, "- [ ] buy milk", 0).doc).toBe("- buy milk");
  });

  it("turns a task off completely", () => {
    expect(run(toggleTask, "- [ ] buy milk", 0).doc).toBe("buy milk");
  });

  it("replaces a numbered marker rather than prefixing it", () => {
    expect(run(toggleBullet, "1. first", 0).doc).toBe("- first");
  });

  it("recognises an already-ticked task", () => {
    expect(run(toggleTask, "- [x] done", 0).doc).toBe("done");
  });

  it("keeps indentation when toggling a nested item", () => {
    expect(run(toggleTask, "    - nested", 0).doc).toBe("    - [ ] nested");
  });

  it("brings a mixed selection up to the same form", () => {
    const result = run(toggleBullet, "one\n- two\nthree", 0, 13);
    expect(result.doc).toBe("- one\n- two\n- three");
  });

  it("leaves blank lines alone inside a multi-line selection", () => {
    const result = run(toggleBullet, "one\n\ntwo", 0, 8);
    expect(result.doc).toBe("- one\n\n- two");
  });

  it("still quotes a list line rather than replacing its marker", () => {
    expect(run(toggleQuote, "- item", 0).doc).toBe("> - item");
  });
});
