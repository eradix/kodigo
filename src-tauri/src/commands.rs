//! The IPC surface. The frontend has no filesystem access of its own, so every
//! read, write and query the UI performs arrives here first.

use crate::error::{AppError, Result};
use crate::index::indexer;
use crate::index::search::{self, NoteRef, SearchHit, TagCount};
use crate::notes::{self, TreeNode};
use crate::state::AppState;
use crate::vault::{self, RecentVault, Vault};
use crate::{import::ImportResult, watcher};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedVault {
    #[serde(flatten)]
    pub vault: Vault,
    pub tree: Vec<TreeNode>,
}

#[tauri::command]
pub fn open_vault(app: AppHandle, state: State<AppState>, path: String) -> Result<OpenedVault> {
    let vault = Vault::open(&PathBuf::from(path))?;

    // Stop the old watcher before swapping databases, so no in-flight event can
    // be applied to the new vault's index.
    state.set_watcher(None);
    let conn = crate::index::open_index(&app, &vault)?;
    state.set_vault(Some(vault.clone()), Some(conn));
    let _ = vault::push_recent(&app, &vault);

    let tree = notes::build_tree(&vault.root, &vault.root)?;

    // The first scan of a large vault should not hold up the window.
    let scan_app = app.clone();
    let scan_root = vault.root.clone();
    std::thread::spawn(move || {
        let state = <AppHandle as tauri::Manager<_>>::state::<AppState>(&scan_app);
        // The user may have switched vaults while this thread was starting; the
        // open database now belongs to a different folder.
        if state.current_vault().map(|v| v.root) != Some(scan_root.clone()) {
            return;
        }
        let _ = state.with_db(|conn| indexer::index_all(&scan_app, conn, &scan_root));
    });

    match watcher::start(app.clone(), vault.clone()) {
        Ok(w) => state.set_watcher(Some(w)),
        // Losing the watcher costs live refresh, not correctness; the app is
        // still fully usable, so this is a warning rather than a failure.
        Err(e) => eprintln!("kodigo: file watching unavailable: {e}"),
    }

    Ok(OpenedVault { vault, tree })
}

#[tauri::command]
pub fn close_vault(state: State<AppState>) {
    state.set_watcher(None);
    state.set_vault(None, None);
}

#[tauri::command]
pub fn current_vault(state: State<AppState>) -> Option<Vault> {
    state.current_vault()
}

#[tauri::command]
pub fn recent_vaults(app: AppHandle) -> Vec<RecentVault> {
    vault::read_recents(&app)
}

#[tauri::command]
pub fn list_tree(state: State<AppState>) -> Result<Vec<TreeNode>> {
    let vault = state.vault()?;
    notes::build_tree(&vault.root, &vault.root)
}

#[tauri::command]
pub fn read_note(state: State<AppState>, rel_path: String) -> Result<String> {
    let vault = state.vault()?;
    notes::read_note(&vault.root, &rel_path)
}

#[tauri::command]
pub fn write_note(state: State<AppState>, rel_path: String, content: String) -> Result<()> {
    let vault = state.vault()?;
    let path = notes::write_note(&vault.root, &rel_path, &content)?;
    // Fingerprint first: if the watcher wakes before this, it would treat our own
    // save as somebody else's edit and prompt the user about it.
    state.remember_self_write(&rel_path, &path);
    state.with_db(|conn| indexer::index_file(conn, &vault.root, &rel_path))
}

#[tauri::command]
pub fn create_note(
    app: AppHandle,
    state: State<AppState>,
    parent_rel: String,
    name: String,
) -> Result<String> {
    let vault = state.vault()?;
    notes::validate_name(&name)?;
    let dir = vault::resolve_in_vault(&vault.root, &parent_rel)?;
    if !dir.is_dir() {
        return Err(AppError::NotFound(parent_rel));
    }
    let file_name = notes::with_note_extension(name.trim());
    let path = notes::unique_in_dir(&dir, &file_name);
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());
    std::fs::write(&path, format!("# {title}\n\n"))?;

    let rel = vault::to_rel(&vault.root, &path).ok_or(AppError::PathEscape(name))?;
    state.remember_self_write(&rel, &path);
    state.with_db(|conn| indexer::index_file(conn, &vault.root, &rel))?;
    let _ = app.emit("vault://tree-changed", ());
    Ok(rel)
}

#[tauri::command]
pub fn create_folder(
    app: AppHandle,
    state: State<AppState>,
    parent_rel: String,
    name: String,
) -> Result<String> {
    let vault = state.vault()?;
    notes::validate_name(&name)?;
    let dir = vault::resolve_in_vault(&vault.root, &parent_rel)?;
    let path = notes::unique_in_dir(&dir, name.trim());
    std::fs::create_dir_all(&path)?;
    let rel = vault::to_rel(&vault.root, &path).ok_or(AppError::PathEscape(name))?;
    let _ = app.emit("vault://tree-changed", ());
    Ok(rel)
}

#[tauri::command]
pub fn rename_entry(
    app: AppHandle,
    state: State<AppState>,
    rel_path: String,
    new_name: String,
) -> Result<String> {
    let vault = state.vault()?;
    notes::validate_name(&new_name)?;
    let from = vault::resolve_in_vault(&vault.root, &rel_path)?;
    if !from.exists() {
        return Err(AppError::NotFound(rel_path));
    }
    let is_dir = from.is_dir();
    let parent = from
        .parent()
        .ok_or_else(|| AppError::InvalidName(new_name.clone()))?;
    let file_name = if is_dir {
        new_name.trim().to_string()
    } else {
        notes::with_note_extension(new_name.trim())
    };
    let to = parent.join(&file_name);
    if to.exists() {
        return Err(AppError::AlreadyExists(file_name));
    }
    std::fs::rename(&from, &to)?;

    let new_rel = vault::to_rel(&vault.root, &to).ok_or(AppError::PathEscape(file_name))?;
    state.with_db(|conn| {
        if is_dir {
            indexer::remove_under(conn, &rel_path)?;
            indexer::index_under(conn, &vault.root, &new_rel)?;
        } else {
            indexer::remove_note(conn, &rel_path)?;
            indexer::index_file(conn, &vault.root, &new_rel)?;
        }
        indexer::prune_tags(conn)
    })?;
    let _ = app.emit("vault://tree-changed", ());
    Ok(new_rel)
}

#[tauri::command]
pub fn delete_entry(app: AppHandle, state: State<AppState>, rel_path: String) -> Result<()> {
    let vault = state.vault()?;
    let path = vault::resolve_in_vault(&vault.root, &rel_path)?;
    if !path.exists() {
        return Err(AppError::NotFound(rel_path));
    }
    let is_dir = path.is_dir();
    // Deliberately the OS trash rather than an unlink: notes are the user's only
    // copy, and a mis-click in a tree should be recoverable.
    trash::delete(&path)?;

    state.with_db(|conn| {
        if is_dir {
            indexer::remove_under(conn, &rel_path)?;
        } else {
            indexer::remove_note(conn, &rel_path)?;
        }
        indexer::prune_tags(conn)
    })?;
    let _ = app.emit("vault://tree-changed", ());
    Ok(())
}

#[tauri::command]
pub fn import_paths(
    app: AppHandle,
    state: State<AppState>,
    paths: Vec<String>,
    dest_rel: String,
) -> Result<ImportResult> {
    let vault = state.vault()?;
    let result = crate::import::import_paths(&vault.root, &dest_rel, &paths)?;
    state.with_db(|conn| {
        for rel in &result.imported {
            indexer::index_file(conn, &vault.root, rel)?;
        }
        Ok(())
    })?;
    let _ = app.emit("vault://tree-changed", ());
    Ok(result)
}

#[tauri::command]
pub fn search_notes(state: State<AppState>, query: String, limit: usize) -> Result<Vec<SearchHit>> {
    state.with_db(|conn| search::search(conn, &query, limit))
}

#[tauri::command]
pub fn quick_switch(state: State<AppState>, query: String, limit: usize) -> Result<Vec<NoteRef>> {
    state.with_db(|conn| search::quick_switch(conn, &query, limit))
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<TagCount>> {
    state.with_db(search::list_tags)
}

#[tauri::command]
pub fn notes_by_tag(state: State<AppState>, tag: String) -> Result<Vec<NoteRef>> {
    state.with_db(|conn| search::notes_by_tag(conn, &tag))
}

#[tauri::command]
pub fn reindex(app: AppHandle, state: State<AppState>) -> Result<usize> {
    let vault = state.vault()?;
    state.with_db(|conn| indexer::index_all(&app, conn, &vault.root))
}
