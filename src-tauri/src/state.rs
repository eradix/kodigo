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
    /// Consumes the record, so a later external edit is reported normally.
    pub fn take_self_write(&self, rel: &str, path: &Path) -> bool {
        let mut writes = self.self_writes.lock().unwrap();
        match (writes.get(rel).copied(), fingerprint(path)) {
            (Some(recorded), Some(current)) if recorded == current => {
                writes.remove(rel);
                true
            }
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
