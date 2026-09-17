//! Watches the vault folder so edits made outside the app show up inside it.

use crate::error::Result;
use crate::index::indexer;
use crate::state::{AppState, VaultWatcher};
use crate::vault::{is_note_file, is_skipped, to_rel, Vault};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
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

/// Collapses a debounced batch to one entry per file.
///
/// A single save shows up as several events naming the same path, and each one
/// used to be handled on its own — so a file could be judged our own write once
/// and an external edit twice in the same batch. Deduplicating first means every
/// file is decided exactly once.
fn distinct_paths(root: &Path, paths: Vec<PathBuf>) -> BTreeMap<String, PathBuf> {
    let mut distinct = BTreeMap::new();
    for path in paths {
        let Some(rel) = to_rel(root, &path) else {
            continue;
        };
        if rel.split('/').any(is_skipped) {
            continue;
        }
        distinct.insert(rel, path);
    }
    distinct
}

/// What a batch of filesystem events means for the app.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Changes {
    /// Notes whose contents need re-reading, and which the editor is told about.
    pub updated: BTreeSet<String>,
    pub removed: BTreeSet<String>,
    pub tree_changed: bool,
}

/// Decides what a batch means, with no database or window involved.
///
/// Kept separate from the work it triggers so the decision can be tested: the
/// case that matters most is a batch produced by the app's own autosave, which
/// must come out empty.
fn classify(state: &AppState, root: &Path, paths: Vec<PathBuf>) -> Changes {
    let mut changes = Changes::default();

    for (rel, path) in distinct_paths(root, paths) {
        let exists = path.exists();

        if !is_note_file(&path) {
            // A folder appearing, moving or disappearing only affects the tree.
            if path.is_dir() || !exists {
                changes.tree_changed = true;
            }
            continue;
        }

        if exists {
            // Our own save, already in the index: nothing to report.
            if state.is_self_write(&rel, &path) {
                continue;
            }
            changes.updated.insert(rel);
        } else {
            state.forget_self_write(&rel);
            changes.removed.insert(rel);
            changes.tree_changed = true;
        }
    }
    changes
}

fn handle_paths(app: &AppHandle, root: &Path, paths: Vec<PathBuf>) {
    let state = app.state::<AppState>();

    // A vault switch may have happened while events were in flight; those events
    // belong to a database that is no longer open.
    match state.current_vault() {
        Some(current) if current.root == root => {}
        _ => return,
    }

    let Changes {
        updated,
        removed,
        mut tree_changed,
    } = classify(&state, root, paths);

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

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        state: AppState,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("kodigo-watch-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Fixture {
                root: root.canonicalize().unwrap(),
                state: AppState::default(),
            }
        }

        /// Saves a note exactly as the write_note command does.
        fn save(&self, rel: &str, body: &str) -> PathBuf {
            let path = crate::notes::write_note(&self.root, rel, body).unwrap();
            self.state.remember_self_write(rel, &path);
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// The bug this guards against: typing in Kodigo, letting autosave fire, and
    /// watching the cursor jump back to the top of the document because the app
    /// had just told itself the file changed underneath it.
    #[test]
    fn an_autosave_reports_nothing_back_to_the_editor() {
        let fixture = Fixture::new("autosave");
        let path = fixture.save("note.md", "# Note\n\nSomething I am typing.");

        // One save arrives as a batch naming the same file several times.
        let batch = vec![path.clone(), path.clone(), path];
        assert_eq!(
            classify(&fixture.state, &fixture.root, batch),
            Changes::default(),
            "the app's own save must not come back as an external change"
        );
    }

    #[test]
    fn repeated_autosaves_stay_silent() {
        let fixture = Fixture::new("repeated");
        for n in 0..4 {
            let path = fixture.save("note.md", &format!("draft {n}"));
            let batch = vec![path.clone(), path];
            assert_eq!(
                classify(&fixture.state, &fixture.root, batch),
                Changes::default(),
                "save {n} leaked an event"
            );
        }
    }

    #[test]
    fn an_edit_from_another_program_is_reported() {
        let fixture = Fixture::new("external");
        let path = fixture.save("note.md", "ours");
        std::fs::write(&path, "written by a different editor entirely").unwrap();

        let changes = classify(&fixture.state, &fixture.root, vec![path]);
        assert_eq!(changes.updated.iter().collect::<Vec<_>>(), vec!["note.md"]);
        assert!(changes.removed.is_empty());
    }

    #[test]
    fn a_deleted_note_is_reported_and_marks_the_tree() {
        let fixture = Fixture::new("deleted");
        let path = fixture.save("note.md", "ours");
        std::fs::remove_file(&path).unwrap();

        let changes = classify(&fixture.state, &fixture.root, vec![path]);
        assert_eq!(changes.removed.iter().collect::<Vec<_>>(), vec!["note.md"]);
        assert!(changes.tree_changed);
    }

    #[test]
    fn the_temp_file_a_save_creates_is_invisible() {
        let fixture = Fixture::new("tempfile");
        let tmp = fixture.root.join(".note.md.kodigo-tmp");
        std::fs::write(&tmp, "half-written").unwrap();
        assert_eq!(
            classify(&fixture.state, &fixture.root, vec![tmp]),
            Changes::default()
        );
    }

    #[test]
    fn collapses_repeated_paths_from_one_save() {
        let root = Path::new("/vault");
        let repeated = vec![
            root.join("note.md"),
            root.join("note.md"),
            root.join("note.md"),
        ];
        let distinct = distinct_paths(root, repeated);
        assert_eq!(distinct.len(), 1, "one save must be decided once, not three times");
        assert!(distinct.contains_key("note.md"));
    }

    #[test]
    fn drops_hidden_and_tooling_paths() {
        let root = Path::new("/vault");
        let paths = vec![
            root.join(".note.md.kodigo-tmp"),
            root.join(".obsidian/config.md"),
            root.join("node_modules/pkg/readme.md"),
            root.join("real.md"),
        ];
        let distinct = distinct_paths(root, paths);
        assert_eq!(distinct.keys().collect::<Vec<_>>(), vec!["real.md"]);
    }
}
