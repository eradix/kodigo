import { Fragment, useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import type { SearchHit } from "../../lib/types";
import { useStore } from "../../state/store";

/** How long typing pauses before a query is sent. */
const DEBOUNCE_MS = 160;

const MATCH_START = "";
const MATCH_END = "";

/**
 * Splits a snippet on the delimiters SQLite inserted and renders the matched
 * runs as `<mark>`. The note's own text only ever becomes a text node, so a note
 * containing HTML cannot inject anything here.
 */
function highlight(snippet: string) {
  return snippet.split(MATCH_START).map((chunk, i) => {
    if (i === 0) return <Fragment key={i}>{chunk}</Fragment>;
    const [matched, ...rest] = chunk.split(MATCH_END);
    return (
      <Fragment key={i}>
        <mark>{matched}</mark>
        {rest.join(MATCH_END)}
      </Fragment>
    );
  });
}

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const openTab = useStore((s) => s.openTab);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setSearched(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const results = await ipc.searchNotes(query);
        if (!cancelled) {
          setHits(results);
          setSearched(true);
        }
      } catch (e) {
        if (!cancelled) toast(ipc.errorMessage(e), "error");
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, toast]);

  return (
    <div>
      <input
        className="panel-input"
        placeholder="Search notes..."
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      {searched && hits.length === 0 && (
        <p className="empty-state">No notes match "{query}".</p>
      )}
      {hits.map((hit) => (
        <button key={hit.relPath} className="search-hit" onClick={() => openTab(hit.relPath)}>
          <div className="title">{hit.title}</div>
          <div className="path">{hit.relPath}</div>
          <div className="snippet">{highlight(hit.snippet)}</div>
        </button>
      ))}
    </div>
  );
}
