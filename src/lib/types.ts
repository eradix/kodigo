/** Shapes mirrored from the Rust serde structs. Keep in step with src-tauri/src. */

export interface Vault {
  root: string;
  id: string;
  name: string;
}

export interface TreeNode {
  name: string;
  relPath: string;
  isDir: boolean;
  children?: TreeNode[] | null;
}

export interface OpenedVault extends Vault {
  tree: TreeNode[];
}

export interface RecentVault {
  path: string;
  name: string;
}

export interface SearchHit {
  relPath: string;
  title: string;
  /** Matches are delimited by U+0002/U+0003; see `highlight()` in SearchPanel. */
  snippet: string;
  score: number;
}

export interface NoteRef {
  relPath: string;
  title: string;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
}

export interface IndexProgress {
  done: number;
  total: number;
}

export interface NoteChanged {
  relPath: string;
}
