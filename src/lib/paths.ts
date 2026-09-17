/** Vault-relative path helpers. Paths always use `/`, and "" is the vault root. */

/** The folder containing `relPath`, or "" when it sits at the vault root. */
export function parentOf(relPath: string | null): string {
  if (!relPath) return "";
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/**
 * Every folder on the way down to `relPath`, outermost first.
 * `"a/b/c.md"` gives `["a", "a/b"]` — the folders the tree must open to show it.
 */
export function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split("/");
  parts.pop();
  const ancestors: string[] = [];
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    ancestors.push(prefix);
  }
  return ancestors;
}
