import { syntaxTree } from "@codemirror/language";
import { Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/**
 * Fenced code blocks: a tinted background, and a small toolbar on the opening
 * fence for changing the language and copying the contents.
 */

const codeLine = Decoration.line({ class: "cm-md-code-line" });
const codeFirst = Decoration.line({ class: "cm-md-code-line cm-md-code-first" });
const codeLast = Decoration.line({ class: "cm-md-code-line cm-md-code-last" });

/** Offered in the language dropdown; anything else can still be typed by hand. */
const LANGUAGES = [
  "text", "bash", "c", "cpp", "css", "go", "html", "java", "javascript", "json",
  "jsx", "kotlin", "lua", "markdown", "php", "python", "ruby", "rust", "sql",
  "swift", "toml", "tsx", "typescript", "xml", "yaml",
];

/** Finds the fenced block containing `pos`, if there is one. */
function fenceAt(view: EditorView, pos: number) {
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  while (node.parent && node.name !== "FencedCode") node = node.parent;
  return node.name === "FencedCode" ? node : null;
}

/** The fence characters and language of an opening fence line. */
function parseOpener(text: string) {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(text);
  if (!match) return null;
  return { indent: match[1], fence: match[2], info: match[3].trim() };
}

class CodeToolbar extends WidgetType {
  constructor(private readonly language: string) {
    super();
  }

  eq(other: CodeToolbar) {
    return other.language === this.language;
  }

  ignoreEvent() {
    // The buttons handle their own clicks; the editor must not treat them as
    // a click into the document.
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-code-toolbar";
    wrap.contentEditable = "false";

    const language = document.createElement("button");
    language.type = "button";
    language.textContent = this.language || "plain text";
    language.title = "Change language";
    language.onmousedown = (e) => {
      e.preventDefault();
      this.chooseLanguage(view, wrap);
    };

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "copy";
    copy.title = "Copy code";
    copy.onmousedown = (e) => {
      e.preventDefault();
      const code = this.codeText(view, wrap);
      if (code === null) return;
      navigator.clipboard.writeText(code).then(
        () => {
          copy.textContent = "copied";
          setTimeout(() => (copy.textContent = "copy"), 1200);
        },
        () => (copy.textContent = "failed"),
      );
    };

    wrap.append(language, copy);
    return wrap;
  }

  /** Resolves the widget's live position, which moves as the document changes. */
  private openerLine(view: EditorView, dom: HTMLElement) {
    const pos = view.posAtDOM(dom);
    return view.state.doc.lineAt(pos);
  }

  private codeText(view: EditorView, dom: HTMLElement): string | null {
    const line = this.openerLine(view, dom);
    const node = fenceAt(view, line.from);
    if (!node) return null;
    const last = view.state.doc.lineAt(node.to);
    const closing = parseOpener(last.text);
    // Exclude both fence lines; an unterminated block simply runs to the end.
    const end = closing ? last.from - 1 : node.to;
    const start = Math.min(line.to + 1, end);
    return view.state.doc.sliceString(start, Math.max(start, end));
  }

  private chooseLanguage(view: EditorView, dom: HTMLElement) {
    const line = this.openerLine(view, dom);
    const opener = parseOpener(line.text);
    if (!opener) return;

    const select = document.createElement("select");
    select.className = "cm-code-language-select";
    for (const lang of LANGUAGES) {
      const option = document.createElement("option");
      option.value = lang === "text" ? "" : lang;
      option.textContent = lang;
      option.selected = option.value === opener.info;
      select.append(option);
    }
    Object.assign(select.style, {
      position: "absolute",
      zIndex: "30",
      font: "inherit",
    });

    const rect = dom.getBoundingClientRect();
    const host = view.dom;
    const hostRect = host.getBoundingClientRect();
    select.style.left = `${rect.left - hostRect.left}px`;
    select.style.top = `${rect.bottom - hostRect.top}px`;
    host.append(select);

    const close = () => select.remove();
    select.onchange = () => {
      const from = line.from + opener.indent.length + opener.fence.length;
      view.dispatch({
        changes: { from, to: line.to, insert: select.value },
      });
      close();
      view.focus();
    };
    select.onblur = close;
    select.focus();
    if (typeof select.showPicker === "function") select.showPicker();
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const found: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode") return;
        const doc = view.state.doc;
        const firstLine = doc.lineAt(node.from);
        const lastLine = doc.lineAt(node.to);

        for (let n = firstLine.number; n <= lastLine.number; n++) {
          const line = doc.line(n);
          const deco =
            n === firstLine.number ? codeFirst : n === lastLine.number ? codeLast : codeLine;
          found.push(deco.range(line.from));
        }

        const opener = parseOpener(firstLine.text);
        found.push(
          Decoration.widget({
            widget: new CodeToolbar(opener?.info ?? ""),
            side: 1,
          }).range(firstLine.to),
        );
      },
    });
  }
  return Decoration.set(found, true);
}

export const codeBlocks = ViewPlugin.fromClass(
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
