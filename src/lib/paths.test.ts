import { describe, expect, it } from "vitest";
import { ancestorsOf, parentOf } from "./paths";

describe("parentOf", () => {
  it("returns the containing folder", () => {
    expect(parentOf("projects/notes/idea.md")).toBe("projects/notes");
  });

  it("returns the root for a note at the top level", () => {
    expect(parentOf("idea.md")).toBe("");
  });

  it("treats no note as the root", () => {
    expect(parentOf(null)).toBe("");
  });
});

describe("ancestorsOf", () => {
  it("lists the folders to open, outermost first", () => {
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
  });

  it("has nothing to open for a top-level note", () => {
    expect(ancestorsOf("c.md")).toEqual([]);
  });
});
