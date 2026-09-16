import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import type { NoteChanged } from "../../lib/types";
import { useStore } from "../../state/store";
import { codeBlocks } from "./codeBlocks";
import { codeHighlighting } from "./highlight";
import { markdownStyling } from "./markdownStyling";
import { formattingKeymap, toolbarActions } from "./shortcuts";
import { slashCommands } from "./slashCommands";

/** How long typing pauses before the note is written to disk. */
const AUTOSAVE_MS = 600;

interface ToolbarPosition {
  x: number;
  y: number;
}

export function Editor() {
  const activeRel = useStore((s) => s.activeRel);
  const setDirty = useStore((s) => s.setDirty);
  const closeTab = useStore((s) => s.closeTab);
  const toast = useStore((s) => s.toast);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Per-tab editor state, so switching tabs keeps undo history and cursor. */
  const statesRef = useRef(new Map<string, EditorState>());
  /** Unsaved text per tab, keyed by path — the queue the autosave drains. */
  const pendingRef = useRef(new Map<string, string>());
  const timerRef = useRef<number | null>(null);
  const shownRelRef = useRef<string | null>(null);

  const [toolbar, setToolbar] = useState<ToolbarPosition | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  /** Writes every queued note. Called on a timer, on tab switch and on close. */
  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const queued = [...pendingRef.current.entries()];
    pendingRef.current.clear();
    for (const [relPath, content] of queued) {
      try {
        await ipc.writeNote(relPath, content);
        setDirty(relPath, false);
      } catch (e) {
        // Put it back: an unwritable note must not silently lose its edits.
        pendingRef.current.set(relPath, content);
        toast(ipc.errorMessage(e), "error");
      }
    }
  }, [setDirty, toast]);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush]);

  const updateToolbar = useCallback((view: EditorView) => {
    const { from, to, empty } = view.state.selection.main;
    const host = hostRef.current;
    if (empty || !host || !view.hasFocus) {
      setToolbar(null);
      return;
    }
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    if (!start || !end) {
      setToolbar(null);
      return;
    }
    const rect = host.getBoundingClientRect();
    setToolbar({
      x: (start.left + end.right) / 2 - rect.left,
      y: Math.min(start.top, end.top) - rect.top - 8,
    });
  }, []);

  // Create the view once; documents are swapped into it as tabs change.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: "", extensions: [] }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  const makeState = useCallback(
    (doc: string) =>
      EditorState.create({
        doc,
        extensions: [
          history(),
          drawSelection(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          bracketMatching(),
          indentOnInput(),
          EditorView.lineWrapping,
          // Formatting bindings come first so Ctrl+E and friends win over any
          // default with the same chord.
          keymap.of([...formattingKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          codeHighlighting,
          markdownStyling,
          codeBlocks,
          slashCommands,
          EditorView.updateListener.of((update) => {
            const rel = shownRelRef.current;
            if (update.docChanged && rel) {
              pendingRef.current.set(rel, update.state.doc.toString());
              setDirty(rel, true);
              scheduleFlush();
            }
            if (update.docChanged || update.selectionSet || update.focusChanged) {
              updateToolbar(update.view);
            }
          }),
        ],
      }),
    [scheduleFlush, setDirty, updateToolbar],
  );

  // Swap the shown document when the active tab changes.
  useEffect(() => {
    let cancelled = false;
    const view = viewRef.current;
    if (!view) return;

    const previous = shownRelRef.current;
    // Save the outgoing tab's editor state and get its text on disk before the
    // document is replaced, or an edit made in the last 600ms would be lost.
    if (previous && previous !== activeRel) {
      statesRef.current.set(previous, view.state);
    }

    void (async () => {
      await flush();
      if (cancelled) return;
      if (!activeRel) {
        shownRelRef.current = null;
        view.setState(makeState(""));
        return;
      }
      let state = statesRef.current.get(activeRel);
      if (!state) {
        try {
          state = makeState(await ipc.readNote(activeRel));
        } catch (e) {
          if (!cancelled) {
            toast(ipc.errorMessage(e), "error");
            closeTab(activeRel);
          }
          return;
        }
        if (cancelled) return;
        statesRef.current.set(activeRel, state);
      }
      shownRelRef.current = activeRel;
      view.setState(state);
      view.focus();
      setToolbar(null);
      setConflict(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeRel, closeTab, flush, makeState, toast]);

  /** Replaces an open tab's document with what is now on disk. */
  const reloadFromDisk = useCallback(
    async (relPath: string) => {
      try {
        const content = await ipc.readNote(relPath);
        const state = makeState(content);
        statesRef.current.set(relPath, state);
        pendingRef.current.delete(relPath);
        setDirty(relPath, false);
        if (shownRelRef.current === relPath && viewRef.current) {
          viewRef.current.setState(state);
        }
        setConflict((current) => (current === relPath ? null : current));
      } catch (e) {
        toast(ipc.errorMessage(e), "error");
      }
    },
    [makeState, setDirty, toast],
  );

  // React to edits made outside the app.
  useEffect(() => {
    const changed = listen<NoteChanged>("note://changed-on-disk", (event) => {
      const rel = event.payload.relPath;
      if (!statesRef.current.has(rel)) return;
      if (pendingRef.current.has(rel)) {
        // Unsaved edits here and a new version there: the user decides, because
        // either direction throws work away.
        setConflict(rel);
      } else {
        void reloadFromDisk(rel);
      }
    });
    const deleted = listen<NoteChanged>("note://deleted-on-disk", (event) => {
      const rel = event.payload.relPath;
      if (!statesRef.current.has(rel)) return;
      statesRef.current.delete(rel);
      pendingRef.current.delete(rel);
      closeTab(rel);
      toast(`"${rel}" was deleted outside Kodigo`);
    });
    return () => {
      void changed.then((un) => un());
      void deleted.then((un) => un());
    };
  }, [closeTab, reloadFromDisk, toast]);

  // Never close the window on top of an unwritten edit.
  useEffect(() => {
    const pending = getCurrentWindow().onCloseRequested(async (event) => {
      if (pendingRef.current.size === 0) return;
      event.preventDefault();
      await flush();
      await getCurrentWindow().destroy();
    });
    return () => {
      void pending.then((un) => un());
    };
  }, [flush]);

  // Tabs are dropped from the store elsewhere (closing, renaming); drop their
  // cached editor states too, so a reopened note is re-read from disk.
  const tabs = useStore((s) => s.tabs);
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.relPath));
    for (const rel of statesRef.current.keys()) {
      if (!open.has(rel)) statesRef.current.delete(rel);
    }
  }, [tabs]);

  const keepMine = () => {
    if (!conflict) return;
    const content = pendingRef.current.get(conflict);
    if (content !== undefined) {
      pendingRef.current.set(conflict, content);
      void flush();
    }
    setConflict(null);
  };

  return (
    <div className="editor-host" ref={hostRef}>
      {conflict && (
        <div className="confirm-bar">
          <span>
            <strong>{conflict}</strong> changed on disk while you were editing it.
          </span>
          <span className="spacer" />
          <button onClick={() => void reloadFromDisk(conflict)}>Use the disk version</button>
          <button onClick={keepMine}>Keep my edits</button>
        </div>
      )}
      {toolbar && (
        <div
          className="floating-toolbar"
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {toolbarActions.map((action) => (
            <button
              key={action.label}
              title={action.title}
              onClick={() => {
                const view = viewRef.current;
                if (!view) return;
                action.run(view);
                view.focus();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
