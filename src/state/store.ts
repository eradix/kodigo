import { create } from "zustand";
import * as ipc from "../lib/ipc";
import type { DocStats } from "../lib/text";
import type { TreeNode, Vault } from "../lib/types";

export type SidebarView = "files" | "search" | "tags";
export type Theme = "dark" | "light";

export interface TabMeta {
  relPath: string;
  title: string;
  dirty: boolean;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

interface Store {
  vault: Vault | null;
  tree: TreeNode[];
  tabs: TabMeta[];
  activeRel: string | null;
  sidebarView: SidebarView;
  theme: Theme;
  toasts: Toast[];
  indexing: { done: number; total: number } | null;
  /** Word and character counts for the note in front, for the status bar. */
  docStats: DocStats | null;

  setVault: (vault: Vault | null, tree: TreeNode[]) => void;
  refreshTree: () => Promise<void>;
  openTab: (relPath: string) => void;
  closeTab: (relPath: string) => void;
  setActive: (relPath: string) => void;
  setDirty: (relPath: string, dirty: boolean) => void;
  renameTab: (oldRel: string, newRel: string) => void;
  setSidebarView: (view: SidebarView) => void;
  toggleTheme: () => void;
  toast: (message: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
  setIndexing: (progress: { done: number; total: number } | null) => void;
  setDocStats: (stats: DocStats | null) => void;
}

/** The last segment of a path, without its extension — what a tab is labelled. */
export function displayName(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.(md|markdown|txt)$/i, "");
}

const STORED_THEME = "kodigo.theme";

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORED_THEME);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Private mode or blocked storage: dark is the documented default.
  }
  return "dark";
}

let toastId = 0;

export const useStore = create<Store>((set, get) => ({
  vault: null,
  tree: [],
  tabs: [],
  activeRel: null,
  sidebarView: "files",
  theme: initialTheme(),
  toasts: [],
  indexing: null,
  docStats: null,

  setVault: (vault, tree) => set({ vault, tree, tabs: [], activeRel: null }),

  refreshTree: async () => {
    if (!get().vault) return;
    try {
      set({ tree: await ipc.listTree() });
    } catch (e) {
      get().toast(ipc.errorMessage(e), "error");
    }
  },

  openTab: (relPath) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.relPath === relPath)) {
      set({
        tabs: [...tabs, { relPath, title: displayName(relPath), dirty: false }],
      });
    }
    set({ activeRel: relPath });
  },

  closeTab: (relPath) => {
    const { tabs, activeRel } = get();
    const index = tabs.findIndex((t) => t.relPath === relPath);
    if (index === -1) return;
    const next = tabs.filter((t) => t.relPath !== relPath);
    // Closing the active tab falls back to its neighbour, the way editors do.
    const nextActive =
      activeRel === relPath ? (next[index] ?? next[index - 1])?.relPath ?? null : activeRel;
    set({ tabs: next, activeRel: nextActive });
  },

  setActive: (relPath) => set({ activeRel: relPath }),

  setDirty: (relPath, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.relPath === relPath ? { ...t, dirty } : t)),
    })),

  renameTab: (oldRel, newRel) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.relPath === oldRel
          ? { ...t, relPath: newRel, title: displayName(newRel) }
          : t,
      ),
      activeRel: s.activeRel === oldRel ? newRel : s.activeRel,
    })),

  setSidebarView: (sidebarView) => set({ sidebarView }),

  toggleTheme: () => {
    const theme: Theme = get().theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORED_THEME, theme);
    } catch {
      // Not worth failing a theme toggle over.
    }
    set({ theme });
  },

  toast: (message, kind = "info") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 3000);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setIndexing: (indexing) => set({ indexing }),

  setDocStats: (docStats) => set({ docStats }),
}));
