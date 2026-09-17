import { describe, expect, it } from "vitest";
import { displayName } from "./store";

describe("displayName", () => {
  it("drops the folders and the extension", () => {
    expect(displayName("projects/notes/idea.md")).toBe("idea");
    expect(displayName("welcome.md")).toBe("welcome");
  });

  it("handles the other note extensions", () => {
    expect(displayName("a.markdown")).toBe("a");
    expect(displayName("a.txt")).toBe("a");
  });

  it("leaves a name with no extension alone", () => {
    expect(displayName("README")).toBe("README");
  });

  it("keeps dots that are part of the name", () => {
    expect(displayName("2026-09-17.notes.md")).toBe("2026-09-17.notes");
  });
});
