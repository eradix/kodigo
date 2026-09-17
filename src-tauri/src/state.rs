//! Process-wide state: the open vault, its index connection, and the file watcher.

use crate::error::{AppError, Result};
use crate::vault::Vault;
use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, RwLock};

pub type VaultWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

#[derive(Default)]
pub struct AppState {
    vault: RwLock<Option<Vault>>,
    db: Mutex<Option<Connection>>,
    watcher: Mutex<Option<VaultWatcher>>,
    /// Fingerprints of writes this process just made, so the watcher can tell its
    /// own echo from a genuine edit made in another editor. Without this, every
    /// autosave would bounce back as an external change.
    self_writes: Mutex<HashMap<String, (u64, i64)>>,
}

impl AppState {
    pub fn vault(&self) -> Result<Vault> {
        self.vault
            .read()
            .unwrap()
            .clone()
            .ok_or(AppError::NoVault)
    }

    pub fn current_vault(&self) -> Option<Vault> {
        self.vault.read().unwrap().clone()
    }

    pub fn set_vault(&self, vault: Option<Vault>, db: Option<Connection>) {
        *self.vault.write().unwrap() = vault;
        *self.db.lock().unwrap() = db;
        self.self_writes.lock().unwrap().clear();
    }

    pub fn set_watcher(&self, watcher: Option<VaultWatcher>) {
        // Dropping the previous debouncer stops its thread, which is what we want
        // when switching vaults.
        *self.watcher.lock().unwrap() = watcher;
    }

    /// Runs `f` against the index connection of the open vault.
    pub fn with_db<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.db.lock().unwrap();
        let conn = guard.as_ref().ok_or(AppError::NoVault)?;
        f(conn)
    }

    /// Records the on-disk fingerprint of a file this process just wrote.
    pub fn remember_self_write(&self, rel: &str, path: &Path) {
        if let Some(fp) = fingerprint(path) {
            self.self_writes.lock().unwrap().insert(rel.to_string(), fp);
        }
    }

    /// True when `path` still looks exactly as this process last wrote it.
    ///
    /// Deliberately does **not** consume the record. A single save arrives as a
    /// batch naming the same file several times, and an earlier version of this
    /// dropped the record on the first of them, so the rest were reported as
    /// somebody else's edit and the editor reloaded itself mid-typing. The
    /// record instead lives until the next write to that path replaces it.
    ///
    /// The cost is a genuine external edit that lands in the same wall-clock
    /// second as our own write *and* leaves the file exactly as many bytes long;
    /// that one is not noticed.
    pub fn is_self_write(&self, rel: &str, path: &Path) -> bool {
        let writes = self.self_writes.lock().unwrap();
        match (writes.get(rel).copied(), fingerprint(path)) {
            (Some(recorded), Some(current)) => recorded == current,
            _ => false,
        }
    }

    pub fn forget_self_write(&self, rel: &str) {
        self.self_writes.lock().unwrap().remove(rel);
    }
}

/// `(size, mtime-in-seconds)` — enough to distinguish our own write from an edit
/// somewhere else, and cheap enough to take on every watcher event.
pub fn fingerprint(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((meta.len(), mtime))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_note(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kodigo-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn one_save_stays_suppressed_across_a_whole_event_batch() {
        let state = AppState::default();
        let path = temp_note("batch.md", "saved by us");
        state.remember_self_write("batch.md", &path);

        // A debounced batch names the same file several times; every one of them
        // has to be recognised, not just the first.
        for attempt in 0..3 {
            assert!(
                state.is_self_write("batch.md", &path),
                "occurrence {attempt} was treated as an external edit"
            );
        }
    }

    #[test]
    fn an_edit_by_someone_else_is_still_reported() {
        let state = AppState::default();
        let path = temp_note("external.md", "saved by us");
        state.remember_self_write("external.md", &path);

        std::fs::write(&path, "a longer body written by another editor").unwrap();
        assert!(!state.is_self_write("external.md", &path));
    }

    #[test]
    fn a_file_we_never_wrote_is_never_suppressed() {
        let state = AppState::default();
        let path = temp_note("unknown.md", "hello");
        assert!(!state.is_self_write("unknown.md", &path));
    }
}
