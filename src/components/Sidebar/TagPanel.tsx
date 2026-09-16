import { useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import type { NoteRef, TagCount } from "../../lib/types";
import { useStore } from "../../state/store";

export function TagPanel() {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteRef[]>([]);
  const openTab = useStore((s) => s.openTab);
  const toast = useStore((s) => s.toast);
  const tree = useStore((s) => s.tree);

  // The tree changing is the cheapest signal that the vault, and so its set of
  // tags, may have moved on.
  useEffect(() => {
    let cancelled = false;
    ipc
      .listTags()
      .then((result) => !cancelled && setTags(result))
      .catch((e) => !cancelled && toast(ipc.errorMessage(e), "error"));
    return () => {
      cancelled = true;
    };
  }, [toast, tree]);

  useEffect(() => {
    if (!selected) {
      setNotes([]);
      return;
    }
    let cancelled = false;
    ipc
      .notesByTag(selected)
      .then((result) => !cancelled && setNotes(result))
      .catch((e) => !cancelled && toast(ipc.errorMessage(e), "error"));
    return () => {
      cancelled = true;
    };
  }, [selected, toast]);

  if (tags.length === 0) {
    return (
      <p className="empty-state">
        No tags yet. Write <code>#like-this</code> in a note, or add a <code>tags:</code>{" "}
        line to its frontmatter.
      </p>
    );
  }

  return (
    <div>
      {tags.map((tag) => (
        <button
          key={tag.name}
          className="tag-row"
          aria-selected={selected === tag.name}
          onClick={() => setSelected((current) => (current === tag.name ? null : tag.name))}
        >
          <span>#{tag.name}</span>
          <span className="count">{tag.count}</span>
        </button>
      ))}

      {selected && (
        <div className="tag-notes">
          {notes.map((note) => (
            <button
              key={note.relPath}
              className="tree-row"
              onClick={() => openTab(note.relPath)}
              title={note.relPath}
            >
              <span className="chevron" />
              <span className="label">{note.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
