import {
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
  snippet,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

/**
 * `/` menu for inserting Markdown structures.
 *
 * It only fires when the slash is the first non-whitespace character on the
 * line, so writing `and/or` mid-sentence never opens a menu.
 */

interface SlashItem {
  name: string;
  detail: string;
  /** A CodeMirror snippet; `${name}` marks a tab stop, `${}` an empty one. */
  template: string;
}

const ITEMS: SlashItem[] = [
  { name: "code", detail: "Fenced code block", template: "```${language}\n${}\n```\n" },
  { name: "table", detail: "Table", template: "| ${Column} | ${Column 2} |\n| --- | --- |\n| ${} |  |\n" },
  { name: "todo", detail: "Task list item", template: "- [ ] ${task}" },
  { name: "bullet", detail: "Bullet list", template: "- ${item}" },
  { name: "numbered", detail: "Numbered list", template: "1. ${item}" },
  { name: "h1", detail: "Heading 1", template: "# ${title}" },
  { name: "h2", detail: "Heading 2", template: "## ${title}" },
  { name: "h3", detail: "Heading 3", template: "### ${title}" },
  { name: "quote", detail: "Blockquote", template: "> ${quote}" },
  { name: "hr", detail: "Horizontal rule", template: "---\n" },
  { name: "link", detail: "Link", template: "[${text}](${url})" },
  { name: "image", detail: "Image", template: "![${alt}](${path})" },
  { name: "frontmatter", detail: "YAML frontmatter", template: "---\ntags: [${tag}]\n---\n" },
  { name: "details", detail: "Collapsible section", template: "<details>\n<summary>${summary}</summary>\n\n${}\n\n</details>\n" },
];

const completions: Completion[] = ITEMS.map((item) => ({
  label: `/${item.name}`,
  detail: item.detail,
  type: "keyword",
  apply: snippet(item.template),
}));

const today: Completion = {
  label: "/date",
  detail: "Today's date",
  type: "text",
  apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
    const iso = new Date().toLocaleDateString("en-CA");
    view.dispatch({
      changes: { from, to, insert: iso },
      selection: { anchor: from + iso.length },
    });
  },
};

function slashSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = /^\s*\/(\w*)$/.exec(before);
  if (!match) return null;
  // Do not pop open on an untouched line unless the user actually typed a slash.
  if (!context.explicit && match[1].length === 0 && before.trim() !== "/") return null;

  return {
    from: context.pos - match[1].length - 1,
    options: [...completions, today],
    validFor: /^\/?\w*$/,
  };
}

export const slashCommands = autocompletion({
  override: [slashSource],
  icons: false,
  activateOnTyping: true,
});
