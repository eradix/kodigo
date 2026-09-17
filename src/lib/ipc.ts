/**
 * The only module that calls `invoke`. Everything the UI knows about the
 * filesystem comes through here, which keeps the command surface in one
 * reviewable place and the rest of the app free of stringly-typed calls.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  ImportResult,
  NoteRef,
  OpenedVault,
  RecentVault,
  SearchHit,
  TagCount,
  TreeNode,
  Vault,
} from "./types";

export const openVault = (path: string) => invoke<OpenedVault>("open_vault", { path });
export const closeVault = () => invoke<void>("close_vault");
export const currentVault = () => invoke<Vault | null>("current_vault");
export const recentVaults = () => invoke<RecentVault[]>("recent_vaults");
/** A vault named on the command line, which wins over the recents list. */
export const startupVault = () => invoke<string | null>("startup_vault");

export const listTree = () => invoke<TreeNode[]>("list_tree");
export const readNote = (relPath: string) => invoke<string>("read_note", { relPath });
export const writeNote = (relPath: string, content: string) =>
  invoke<void>("write_note", { relPath, content });
export const createNote = (parentRel: string, name: string) =>
  invoke<string>("create_note", { parentRel, name });
export const createFolder = (parentRel: string, name: string) =>
  invoke<string>("create_folder", { parentRel, name });
export const renameEntry = (relPath: string, newName: string) =>
  invoke<string>("rename_entry", { relPath, newName });
export const deleteEntry = (relPath: string) => invoke<void>("delete_entry", { relPath });

export const importPaths = (paths: string[], destRel: string) =>
  invoke<ImportResult>("import_paths", { paths, destRel });

export const searchNotes = (query: string, limit = 60) =>
  invoke<SearchHit[]>("search_notes", { query, limit });
export const quickSwitch = (query: string, limit = 20) =>
  invoke<NoteRef[]>("quick_switch", { query, limit });
export const listTags = () => invoke<TagCount[]>("list_tags");
export const notesByTag = (tag: string) => invoke<NoteRef[]>("notes_by_tag", { tag });
export const reindex = () => invoke<number>("reindex");

/** Errors cross the IPC boundary as plain strings; this normalises them. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
