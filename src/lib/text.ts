export interface DocStats {
  words: number;
  chars: number;
}

/**
 * Word and character counts for the status bar.
 *
 * Counts what a writer would count: frontmatter is metadata rather than prose,
 * so it is left out, and a run of punctuation on its own is not a word.
 */
export function countDoc(text: string): DocStats {
  let body = text;
  const opened = /^---\r?\n/.exec(body);
  if (opened) {
    const rest = body.slice(opened[0].length);
    const closed = /^(?:\.\.\.|---)[ \t]*$/m.exec(rest);
    if (closed) body = rest.slice(closed.index + closed[0].length);
  }

  const words = body.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return { words, chars: body.length };
}
