import { LanguageDescription } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { codeLanguages } from "./codeLanguages";

describe("fenced code languages", () => {
  it("parses a PHP fence as plain PHP without requiring an opening tag", async () => {
    const description = LanguageDescription.matchLanguageName(codeLanguages, "php");
    expect(description).not.toBeNull();

    const support = await description!.load();
    const tree = support.language.parser.parse("enum Direction { case North; }");

    expect(tree.toString()).toContain("EnumDeclaration");
    expect(tree.toString()).not.toBe("Template(Text)");
  });

  it("keeps the standard language registry available for other fences", () => {
    expect(LanguageDescription.matchLanguageName(codeLanguages, "javascript")).not.toBeNull();
    expect(LanguageDescription.matchLanguageName(codeLanguages, "python")).not.toBeNull();
  });
});
