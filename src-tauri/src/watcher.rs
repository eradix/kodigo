//! Watches the vault folder so edits made outside the app show up inside it.

use crate::error::Result;
use crate::index::indexer;
use crate::state::{AppState, VaultWatcher};
use crate::vault::{is_note_file, is_skipped, to_rel, Vault};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteChanged {
    pub rel_path: String,
}

/// Debounce window. Long enough that a save from another editor (which is often
/// a write plus a rename plus a chmod) arrives as one event, short enough that
/// the change feels immediate.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Starts watching `vault`. The returned debouncer owns the watcher thread, so
/// the caller must keep it alive; dropping it stops watching.
pub fn start(app: AppHandle, vault: Vault) -> Result<VaultWatcher> {
    let root = vault.root.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let paths: Vec<_> = events.into_iter().flat_map(|e| e.paths.clone()).collect();
        handle_paths(&app, &root, paths);
    })?;
    debouncer.watch(&vault.root, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

fn handle_paths(app: &AppHandle, root: &Path, paths: Vec<std::path::PathBuf>) {
    let state = app.state::<AppState>();

    // A vault switch may have happened while events were in flight; those events
    // belong to a database that is no longer open.
    match state.current_vault() {
        Some(current) if current.root == root => {}
        _ => return,
    }

    let mut updated: BTreeSet<String> = BTreeSet::new();
    let mut removed: BTreeSet<String> = BTreeSet::new();
    let mut tree_changed = false;

    for path in paths {
        let Some(rel) = to_rel(root, &path) else {
            continue;
        };
        if rel.split('/').any(is_skipped) {
            continue;
        }
        let exists = path.exists();

        if !is_note_file(&path) {
            // A folder appearing, moving or disappearing only affects the tree.
            if path.is_dir() || !exists {
                tree_changed = true;
            }
            continue;
        }

        if exists {
            // Our own save, already in the index: nothing to report.
            if state.take_self_write(&rel, &path) {
                continue;
            }
            updated.insert(rel);
        } else {
            state.forget_self_write(&rel);
            removed.insert(rel);
            tree_changed = true;
        }
    }

    if updated.is_empty() && removed.is_empty() && !tree_changed {
        return;
    }

    let known_before: BTreeSet<String> = state
        .with_db(|conn| {
            let mut stmt = conn.prepare("SELECT rel_path FROM notes")?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
        .unwrap_or_default();

    let _ = state.with_db(|conn| {
        for rel in &updated {
            indexer::index_file(conn, root, rel)?;
        }
        for rel in &removed {
            indexer::remove_note(conn, rel)?;
        }
        indexer::prune_tags(conn)?;
        Ok(())
    });

    // A note that was not in the index is new, which means the tree changed too.
    if updated.iter().any(|rel| !known_before.contains(rel)) {
        tree_changed = true;
    }
    if tree_changed {
        let _ = app.emit("vault://tree-changed", ());
    }
    for rel in updated {
        let _ = app.emit("note://changed-on-disk", NoteChanged { rel_path: rel });
    }
    for rel in removed {
        let _ = app.emit("note://deleted-on-disk", NoteChanged { rel_path: rel });
    }
}
