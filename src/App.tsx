import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { Editor } from "./components/Editor/Editor";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { TabBar } from "./components/TabBar";
import { Toasts } from "./components/Toasts";
import { Welcome } from "./components/Welcome";
import * as ipc from "./lib/ipc";
import { parentOf } from "./lib/paths";
import type { IndexProgress } from "./lib/types";
import { useStore } from "./state/store";

export default function App() {
  const vault = useStore((s) => s.vault);
  const theme = useStore((s) => s.theme);
  const activeRel = useStore((s) => s.activeRel);
  const tabs = useStore((s) => s.tabs);
  const indexing = useStore((s) => s.indexing);
  const docStats = useStore((s) => s.docStats);
  const setVault = useStore((s) => s.setVault);
  const refreshTree = useStore((s) => s.refreshTree);
  const toast = useStore((s) => s.toast);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const openVault = useCallback(
    async (path: string) => {
      try {
        const opened = await ipc.openVault(path);
        setVault({ root: opened.root, id: opened.id, name: opened.name }, opened.tree);
      } catch (e) {
        toast(ipc.errorMessage(e), "error");
      }
    },
    [setVault, toast],
  );

  const pickVault = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose a vault folder" });
    if (typeof picked === "string") await openVault(picked);
  }, [openVault]);

  // On launch, reopen whatever was open last. A dev-server reload also lands
  // here, and the Rust side still holds the vault, so it is restored directly.
  useEffect(() => {
    void (async () => {
      try {
        const existing = await ipc.currentVault();
        if (existing) {
          setVault(existing, await ipc.listTree());
        } else {
          const recents = await ipc.recentVaults();
          if (recents[0]) await openVault(recents[0].path);
        }
      } catch (e) {
        toast(ipc.errorMessage(e), "error");
      } finally {
        setBooted(true);
      }
    })();
  }, [openVault, setVault, toast]);

  // Window title tracks the note in front, the way a document app should.
  useEffect(() => {
    const note = tabs.find((t) => t.relPath === activeRel);
    const title = note
      ? `${note.dirty ? "• " : ""}${note.title} - ${vault?.name ?? "Kodigo"}`
      : vault
        ? `${vault.name} - Kodigo`
        : "Kodigo";
    void getCurrentWindow().setTitle(title);
  }, [activeRel, tabs, vault]);

  useEffect(() => {
    const tree = listen("vault://tree-changed", () => void refreshTree());
    const progress = listen<IndexProgress>("index://progress", (event) => {
      const { done, total } = event.payload;
      useStore.getState().setIndexing(done >= total ? null : { done, total });
    });
    const finished = listen("index://done", () => useStore.getState().setIndexing(null));
    return () => {
      void tree.then((un) => un());
      void progress.then((un) => un());
      void finished.then((un) => un());
    };
  }, [refreshTree]);

  // Files dragged in from the OS file manager.
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropActive(Boolean(useStore.getState().vault));
        return;
      }
      setDropActive(false);
      if (event.payload.type !== "drop") return;

      const store = useStore.getState();
      if (!store.vault) {
        store.toast("Open a vault before dropping files into it", "error");
        return;
      }
      try {
        const result = await ipc.importPaths(event.payload.paths, parentOf(store.activeRel));
        await store.refreshTree();
        if (result.imported[0]) store.openTab(result.imported[0]);
        if (result.imported.length > 0) {
          store.toast(
            `Imported ${result.imported.length} note${result.imported.length === 1 ? "" : "s"}`,
          );
        }
        if (result.skipped.length > 0) {
          store.toast(`Not Markdown, skipped: ${result.skipped.join(", ")}`, "error");
        }
      } catch (e) {
        store.toast(ipc.errorMessage(e), "error");
      }
    });
    return () => {
      void pending.then((un) => un());
    };
  }, []);

  // Application shortcuts. Editor-local bindings live in the CodeMirror keymap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const store = useStore.getState();

      if (e.key === "o" || e.key === "p") {
        e.preventDefault();
        if (store.vault) setSwitcherOpen(true);
      } else if (e.key === "w") {
        e.preventDefault();
        if (store.activeRel) store.closeTab(store.activeRel);
      } else if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        store.setSidebarView("search");
      } else if (e.key === "n") {
        e.preventDefault();
        if (!store.vault) return;
        void ipc
          .createNote(parentOf(store.activeRel), "Untitled")
          .then(async (rel) => {
            await store.refreshTree();
            store.openTab(rel);
          })
          .catch((err) => store.toast(ipc.errorMessage(err), "error"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!booted) return null;

  if (!vault) {
    return (
      <>
        <Welcome onPick={() => void pickVault()} onOpen={(path) => void openVault(path)} />
        <Toasts />
      </>
    );
  }

  return (
    <>
      <div className="workspace">
        <Sidebar onSwitchVault={() => void pickVault()} />
        <main className="main">
          <TabBar />
          <Editor />
          <div className="status-bar">
            <span>{activeRel ?? "No note open"}</span>
            <span className="spacer" />
            {indexing && (
              <span>
                Indexing {indexing.done}/{indexing.total}
              </span>
            )}
            {docStats && (
              <span>
                {docStats.words.toLocaleString()} {docStats.words === 1 ? "word" : "words"}
                {" \u00b7 "}
                {docStats.chars.toLocaleString()} chars
              </span>
            )}
            <span>{tabs.length} open</span>
          </div>
        </main>
      </div>

      {switcherOpen && <QuickSwitcher onClose={() => setSwitcherOpen(false)} />}
      {dropActive && <div className="drop-overlay">Drop Markdown files to add them here</div>}
      <Toasts />
    </>
  );
}
