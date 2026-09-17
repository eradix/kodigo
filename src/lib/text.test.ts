import { describe, expect, it } from "vitest";
import { countDoc } from "./text";

describe("countDoc", () => {
  it("counts words separated by any whitespace", () => {
    expect(countDoc("one two\tthree\nfour").words).toBe(4);
  });

  it("does not count bare punctuation as a word", () => {
    expect(countDoc("a --- b").words).toBe(2);
  });

  it("counts a hyphenated word once", () => {
    expect(countDoc("well-known example").words).toBe(2);
  });

  it("ignores frontmatter, which is metadata rather than prose", () => {
    const doc = "---\ntitle: A note\ntags: [a, b]\n---\nJust three words\n";
    expect(countDoc(doc).words).toBe(3);
  });

  it("leaves a document alone when the frontmatter is unterminated", () => {
    expect(countDoc("---\ntitle: oops\nstill going").words).toBeGreaterThan(3);
  });

  it("handles an empty document", () => {
    expect(countDoc("")).toEqual({ words: 0, chars: 0 });
  });
});
