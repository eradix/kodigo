import { syntaxTree } from "@codemirror/language";
import { EditorState, Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * Hides Markdown syntax until the caret reaches it.
 *
 * A heading reads as a heading, not as `## heading`, until you put the cursor on
 * that line — then the hashes reappear and can be edited like any other text.
 * The same for emphasis markers, backticks and fences. The document itself is
 * never touched; only its presentation changes, so what is on disk is always
 * exactly what was typed.
 *
 * Hidden ranges are also registered as atomic, so arrow keys step over a marker
 * in one go instead of appearing to stall on characters that are not on screen.
 */

const hidden = Decoration.replace({});

/** True when any cursor or selection overlaps this span. */
function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** Colours allowed through from a note into a style attribute. */
const SAFE_COLOUR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/i;

/**
 * A colour is note content going into CSS, so it is matched against a whitelist
 * rather than trusted. Without this, `red; background: url(...)` in a note would
 * become a style declaration of its own.
 */
function safeColour(raw: string): string | null {
  const colour = raw.trim();
  return SAFE_COLOUR.test(colour) ? colour : null;
}

/** `<font color="green">` and `<span style="color: green">`, both closed. */
const COLOUR_TAGS = [
  /(<font\s+color\s*=\s*["']?([^"'>]+?)["']?\s*>)([\s\S]*?)(<\/font\s*>)/gi,
  /(<span\s+style\s*=\s*["'][^"']*?color\s*:\s*([^;"']+)[^"']*["']\s*>)([\s\S]*?)(<\/span\s*>)/gi,
];

function hide(found: Range<Decoration>[], from: number, to: number) {
  if (to > from) found.push(hidden.range(from, to));
}

/**
 * Syntax that is hidden when the caret is elsewhere, and what counts as "near
 * enough" to bring it back. Markers inside a word reveal with that word; the
 * hashes of a heading and the fences of a code block reveal with the whole
 * construct, so that editing anywhere inside one shows all of its syntax.
 */
function collectMarkers(view: EditorView, found: Range<Decoration>[]) {
  const { state } = view;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        if (/^ATXHeading[1-6]$/.test(name)) {
          const line = state.doc.lineAt(node.from);
          if (touched(state, line.from, line.to)) return;
          const mark = node.node.getChild("HeaderMark");
          if (!mark) return;
          // Take the space after the hashes too, or the heading keeps an indent
          // that is not in the file.
          const after = state.doc.sliceString(mark.to, mark.to + 1);
          hide(found, mark.from, after === " " ? mark.to + 1 : mark.to);
          return;
        }

        if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
          if (touched(state, node.from, node.to)) return;
          for (const child of node.node.getChildren("EmphasisMark")) {
            hide(found, child.from, child.to);
          }
          for (const child of node.node.getChildren("StrikethroughMark")) {
            hide(found, child.from, child.to);
          }
          return;
        }

        if (name === "InlineCode") {
          if (touched(state, node.from, node.to)) return;
          for (const child of node.node.getChildren("CodeMark")) {
            hide(found, child.from, child.to);
          }
          return;
        }

        if (name === "FencedCode") {
          if (touched(state, node.from, node.to)) return;
          // The fence characters and the language label, leaving the code. The
          // lines themselves stay, and keep the block's background.
          for (const child of node.node.getChildren("CodeMark")) {
            hide(found, child.from, child.to);
          }
          const info = node.node.getChild("CodeInfo");
          if (info) hide(found, info.from, info.to);
          return;
        }

        if (name === "Link") {
          if (touched(state, node.from, node.to)) return;
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          // `[text](url)` becomes `text`: the opening bracket, then everything
          // from the closing bracket to the end of the link.
          if (marks.length >= 2 && url) {
            hide(found, marks[0].from, marks[0].to);
            hide(found, marks[1].from, node.to);
          }
        }
      },
    });
  }
}

/**
 * Inline colour tags. Markdown has no syntax for coloured text, so a note that
 * wants it reaches for HTML; this renders that rather than leaving the tags
 * sitting in the prose.
 */
function collectColours(view: EditorView, found: Range<Decoration>[]) {
  const { state } = view;

  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;

    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      if (!line.text.includes("<")) continue;

      for (const pattern of COLOUR_TAGS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line.text)) !== null) {
          const [whole, openTag, rawColour, inner, closeTag] = match;
          const colour = safeColour(rawColour);
          if (!colour) continue;

          const start = line.from + match.index;
          const openTo = start + openTag.length;
          const innerTo = openTo + inner.length;
          const end = start + whole.length;

          if (inner.length > 0) {
            found.push(
              Decoration.mark({ attributes: { style: `color: ${colour}` } }).range(
                openTo,
                innerTo,
              ),
            );
          }
          // The tags themselves get out of the way unless they are being edited.
          if (!touched(state, start, end)) {
            hide(found, start, openTo);
            hide(found, innerTo, end);
          }
          void closeTag;
        }
      }
    }
  }
}

function build(view: EditorView): DecorationSet {
  const found: Range<Decoration>[] = [];
  collectMarkers(view, found);
  collectColours(view, found);
  return Decoration.set(found, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      // Unlike the styling plugin, this one also rebuilds when the selection
      // moves: where the caret is decides what is revealed.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = build(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // Without this the caret can be asked to sit inside text that is not drawn,
    // and an arrow key looks as though it did nothing.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);
