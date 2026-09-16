import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Colours for code inside fenced blocks. Every value is a CSS variable, so the
 * light/dark toggle repaints the editor without rebuilding any extension.
 */
const style = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--syn-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "var(--syn-var)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.derefOperator], color: "var(--syn-op)" },
  { tag: [t.definition(t.variableName), t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);

export const codeHighlighting = syntaxHighlighting(style);
