import { syntaxTree } from "@codemirror/language";
import { Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * Live styling for Markdown source.
 *
 * Headings grow, emphasis renders, code gets a chip — but the syntax characters
 * stay on screen, only dimmed. Hiding markers on inactive lines is the usual next
 * step and also the usual source of cursor-placement bugs, so it is deliberately
 * left out: what you see here is exactly the text in the file.
 */

const marks = {
  marker: Decoration.mark({ class: "cm-md-marker" }),
  listMarker: Decoration.mark({ class: "cm-md-list-marker" }),
  bold: Decoration.mark({ class: "cm-md-bold" }),
  italic: Decoration.mark({ class: "cm-md-italic" }),
  strike: Decoration.mark({ class: "cm-md-strike" }),
  inlineCode: Decoration.mark({ class: "cm-md-inline-code" }),
  link: Decoration.mark({ class: "cm-md-link" }),
  url: Decoration.mark({ class: "cm-md-url" }),
  quote: Decoration.mark({ class: "cm-md-quote" }),
  hr: Decoration.mark({ class: "cm-md-hr" }),
};

const quoteLine = Decoration.line({ class: "cm-md-quote-line" });
const frontmatterLine = Decoration.line({ class: "cm-md-frontmatter-line" });

const headingMark = (level: number) =>
  Decoration.mark({ class: `cm-md-heading cm-md-h${level}` });

const headings: Record<string, Decoration> = {};
for (let level = 1; level <= 6; level++) {
  headings[`ATXHeading${level}`] = headingMark(level);
  headings[`SetextHeading${Math.min(level, 2)}`] = headingMark(Math.min(level, 2));
}

/** Frontmatter is not part of the Markdown grammar, so it is matched by hand. */
function frontmatterRange(view: EditorView): [number, number] | null {
  const first = view.state.doc.line(1);
  if (first.text.trim() !== "---") return null;
  for (let n = 2; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const text = line.text.trim();
    if (text === "---" || text === "...") return [1, n];
  }
  return null;
}

function buildDecorations(view: EditorView): DecorationSet {
  const found: Range<Decoration>[] = [];
  const seenLines = new Set<number>();

  const fm = frontmatterRange(view);
  if (fm) {
    for (let n = fm[0]; n <= fm[1]; n++) {
      found.push(frontmatterLine.range(view.state.doc.line(n).from));
      seenLines.add(n);
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        // Inside frontmatter the Markdown tree is meaningless (it parses the
        // block as a setext heading and a paragraph), so leave it alone.
        if (fm && node.from < view.state.doc.line(fm[1]).to) return;

        const heading = headings[node.name];
        if (heading && node.to > node.from) {
          found.push(heading.range(node.from, node.to));
          return;
        }

        switch (node.name) {
          case "StrongEmphasis":
            found.push(marks.bold.range(node.from, node.to));
            break;
          case "Emphasis":
            found.push(marks.italic.range(node.from, node.to));
            break;
          case "Strikethrough":
            found.push(marks.strike.range(node.from, node.to));
            break;
          case "InlineCode":
            found.push(marks.inlineCode.range(node.from, node.to));
            break;
          case "Link":
          case "Image":
            found.push(marks.link.range(node.from, node.to));
            break;
          case "URL":
            found.push(marks.url.range(node.from, node.to));
            break;
          case "HorizontalRule":
            found.push(marks.hr.range(node.from, node.to));
            break;
          case "ListMark":
            found.push(marks.listMarker.range(node.from, node.to));
            break;
          case "HeaderMark":
          case "EmphasisMark":
          case "StrikethroughMark":
          case "LinkMark":
          case "QuoteMark":
            if (node.to > node.from) found.push(marks.marker.range(node.from, node.to));
            break;
          case "CodeMark":
            // Fence delimiters belong to the code-block extension.
            if (node.node.parent?.name !== "FencedCode" && node.to > node.from) {
              found.push(marks.marker.range(node.from, node.to));
            }
            break;
          case "Blockquote": {
            const start = view.state.doc.lineAt(node.from).number;
            const end = view.state.doc.lineAt(node.to).number;
            for (let n = start; n <= end; n++) {
              if (seenLines.has(n)) continue;
              seenLines.add(n);
              found.push(quoteLine.range(view.state.doc.line(n).from));
            }
            found.push(marks.quote.range(node.from, node.to));
            break;
          }
        }
      },
    });
  }

  // Ranges are gathered out of order (line decorations first, then the tree
  // walk), so let the range set sort them.
  return Decoration.set(found, true);
}

export const markdownStyling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
