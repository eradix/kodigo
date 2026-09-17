import { EditorSelection, Line } from "@codemirror/state";
import { EditorView, KeyBinding } from "@codemirror/view";

/**
 * Markdown formatting commands. The keymap and the floating toolbar both call
 * these, so a shortcut and a button can never drift apart.
 */
export type FormatCommand = (view: EditorView) => boolean;

/** Wraps the selection in `before`/`after`, or unwraps it if already wrapped. */
function toggleWrap(before: string, after = before): FormatCommand {
  return (view) => {
    const tr = view.state.changeByRange((range) => {
      const { from, to } = range;
      const doc = view.state.doc;

      // Markers just outside the selection: the common case after wrapping once.
      const pre = doc.sliceString(Math.max(0, from - before.length), from);
      const post = doc.sliceString(to, Math.min(doc.length, to + after.length));
      if (pre === before && post === after) {
        return {
          changes: [
            { from: from - before.length, to: from },
            { from: to, to: to + after.length },
          ],
          range: EditorSelection.range(from - before.length, to - before.length),
        };
      }

      // Markers inside the selection: the user selected the whole `**word**`.
      const inner = doc.sliceString(from, to);
      if (
        inner.length >= before.length + after.length &&
        inner.startsWith(before) &&
        inner.endsWith(after)
      ) {
        return {
          changes: {
            from,
            to,
            insert: inner.slice(before.length, inner.length - after.length),
          },
          range: EditorSelection.range(from, to - before.length - after.length),
        };
      }

      return {
        changes: [
          { from, insert: before },
          { from: to, insert: after },
        ],
        range: EditorSelection.range(from + before.length, to + before.length),
      };
    });
    view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("*");
export const toggleStrikethrough = toggleWrap("~~");
export const toggleInlineCode = toggleWrap("`");
export const toggleHighlight = toggleWrap("==");

function selectedLines(view: EditorView): Line[] {
  const lines: Line[] = [];
  const seen = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const start = view.state.doc.lineAt(range.from).number;
    const end = view.state.doc.lineAt(range.to).number;
    for (let n = start; n <= end; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(view.state.doc.line(n));
      }
    }
  }
  return lines;
}

/** Applies `#` × level to every selected line, or removes it if already there. */
export function setHeading(level: number): FormatCommand {
  return (view) => {
    const prefix = "#".repeat(level) + " ";
    const lines = selectedLines(view);
    const allAtLevel = lines.every((line) => line.text.startsWith(prefix));
    const changes = lines.map((line) => {
      const existing = /^#{1,6}\s+/.exec(line.text)?.[0] ?? "";
      return {
        from: line.from,
        to: line.from + existing.length,
        insert: allAtLevel ? "" : prefix,
      };
    });
    view.dispatch({ changes, userEvent: "input.format" });
    return true;
  };
}

/** Any leading list marker: a bullet, a task box, or a number. */
const LIST_MARKER = /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

const indentOf = (text: string) => /^\s*/.exec(text)![0];

/**
 * Toggles a line prefix such as `> `, `- ` or `- [ ] ` on the selected lines.
 *
 * `detect` asks whether a line is already in the target form, while `strip` says
 * what leading run the prefix replaces. Keeping them apart is what lets a bullet
 * become a task rather than growing a second marker in front of the first.
 */
export function toggleLinePrefix(
  prefix: string,
  detect: RegExp,
  strip: RegExp = detect,
): FormatCommand {
  return (view) => {
    const selected = selectedLines(view);
    // A blank line in the middle of a selected block is a paragraph break, not
    // an empty list item.
    const lines =
      selected.length > 1 ? selected.filter((line) => line.text.trim() !== "") : selected;
    if (lines.length === 0) return true;

    const body = (line: Line) => line.text.slice(indentOf(line.text).length);
    const allPresent = lines.every((line) => detect.test(body(line)));

    const changes = lines.map((line) => {
      const indent = indentOf(line.text).length;
      const existing = strip.exec(body(line))?.[0] ?? "";
      return {
        from: line.from + indent,
        to: line.from + indent + existing.length,
        insert: allPresent ? "" : prefix,
      };
    });
    view.dispatch({ changes, userEvent: "input.format" });
    return true;
  };
}

export const toggleQuote = toggleLinePrefix("> ", /^>\s?/);
// A bullet is only a plain bullet when no task box follows it.
export const toggleBullet = toggleLinePrefix(
  "- ",
  /^[-*+]\s+(?!\[[ xX]\]\s)/,
  LIST_MARKER,
);
export const toggleTask = toggleLinePrefix("- [ ] ", /^[-*+]\s+\[[ xX]\]\s+/, LIST_MARKER);

/** Wraps the selection in a fenced block, leaving the cursor on the info string. */
export const insertCodeBlock: FormatCommand = (view) => {
  const range = view.state.selection.main;
  const doc = view.state.doc;
  const startLine = doc.lineAt(range.from);
  const endLine = doc.lineAt(range.to);
  const body = doc.sliceString(startLine.from, endLine.to);

  const insert = "```\n" + body + "\n```";
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert },
    // Cursor sits right after the opening backticks so a language can be typed.
    selection: EditorSelection.cursor(startLine.from + 3),
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return true;
};

/** `[selection](url)` with the cursor in the URL, or an empty link template. */
export const insertLink: FormatCommand = (view) => {
  const tr = view.state.changeByRange((range) => {
    const text = view.state.doc.sliceString(range.from, range.to);
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length - 1),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
  return true;
};

export const formattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold, preventDefault: true },
  { key: "Mod-i", run: toggleItalic, preventDefault: true },
  { key: "Mod-e", run: toggleInlineCode, preventDefault: true },
  { key: "Mod-Shift-c", run: insertCodeBlock, preventDefault: true },
  { key: "Mod-Shift-x", run: toggleStrikethrough, preventDefault: true },
  { key: "Mod-Shift-q", run: toggleQuote, preventDefault: true },
  { key: "Mod-Shift-l", run: toggleBullet, preventDefault: true },
  { key: "Mod-Shift-t", run: toggleTask, preventDefault: true },
  { key: "Mod-k", run: insertLink, preventDefault: true },
  { key: "Mod-1", run: setHeading(1), preventDefault: true },
  { key: "Mod-2", run: setHeading(2), preventDefault: true },
  { key: "Mod-3", run: setHeading(3), preventDefault: true },
];

export interface ToolbarAction {
  label: string;
  title: string;
  run: FormatCommand;
}

/** Buttons shown in the floating toolbar, in order. */
export const toolbarActions: ToolbarAction[] = [
  { label: "B", title: "Bold (Ctrl+B)", run: toggleBold },
  { label: "I", title: "Italic (Ctrl+I)", run: toggleItalic },
  { label: "S", title: "Strikethrough (Ctrl+Shift+X)", run: toggleStrikethrough },
  { label: "</>", title: "Inline code (Ctrl+E)", run: toggleInlineCode },
  { label: "{ }", title: "Code block (Ctrl+Shift+C)", run: insertCodeBlock },
  { label: "H1", title: "Heading 1 (Ctrl+1)", run: setHeading(1) },
  { label: "H2", title: "Heading 2 (Ctrl+2)", run: setHeading(2) },
  { label: "🔗", title: "Link (Ctrl+K)", run: insertLink },
  { label: "❝", title: "Quote (Ctrl+Shift+Q)", run: toggleQuote },
];
