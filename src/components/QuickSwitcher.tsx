import { useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import type { NoteRef } from "../lib/types";
import { useStore } from "../state/store";

/**
 * Ctrl+O: jump to a note by name. An empty query lists recent-ish notes (the
 * index's natural order), so the palette is never an empty box.
 */
export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRef[]>([]);
  const [cursor, setCursor] = useState(0);
  const openTab = useStore((s) => s.openTab);
  const toast = useStore((s) => s.toast);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    ipc
      .quickSwitch(query)
      .then((hits) => {
        if (cancelled) return;
        setResults(hits);
        setCursor(0);
      })
      .catch((e) => !cancelled && toast(ipc.errorMessage(e), "error"));
    return () => {
      cancelled = true;
    };
  }, [query, toast]);

  const choose = (note: NoteRef | undefined) => {
    if (!note) return;
    openTab(note.relPath);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="quick-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Go to note..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[cursor]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <div className="results">
          {results.length === 0 && <p className="empty-state">No matching notes.</p>}
          {results.map((note, i) => (
            <button
              key={note.relPath}
              className="result"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(note)}
            >
              <span>{note.title}</span>
              <span className="path">{note.relPath}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
