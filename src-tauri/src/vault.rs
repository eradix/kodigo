//! Vault identity, path safety, and the list of recently opened vaults.

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// File extensions the app treats as notes. Anything else is invisible to the
/// tree, the index and the importer.
pub const NOTE_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

/// Directory names never worth walking into inside a notes folder.
const SKIPPED_DIRS: [&str; 4] = ["node_modules", "target", ".git", ".obsidian"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub root: PathBuf,
    /// Stable id derived from the canonical path; names this vault's index DB.
    pub id: String,
    pub name: String,
}

impl Vault {
    pub fn open(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .map_err(|_| AppError::NotFound(root.display().to_string()))?;
        if !root.is_dir() {
            return Err(AppError::Other(format!(
                "{} is not a folder",
                root.display()
            )));
        }
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.display().to_string());
        Ok(Vault {
            id: hash_path(&root),
            root,
            name,
        })
    }
}

fn hash_path(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn is_note_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| NOTE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Hidden entries and heavyweight tool directories are skipped everywhere:
/// the tree, the indexer and the watcher all agree on this predicate.
pub fn is_skipped(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

/// Turns a vault-relative path from the frontend into an absolute one, refusing
/// anything that would leave the vault. This is the single chokepoint every
/// path-taking command goes through, so traversal only has to be got right here.
pub fn resolve_in_vault(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    let candidate = Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.contains('\0') {
                    return Err(AppError::InvalidName(rel.to_string()));
                }
            }
            // `..`, a leading `/`, or a Windows drive prefix: all escapes.
            _ => return Err(AppError::PathEscape(rel.to_string())),
        }
    }

    let joined = root.join(candidate);
    // Canonicalize what exists so symlinks cannot point outward. For a path being
    // created, the parent is the deepest thing that can be checked.
    let anchor = if joined.exists() {
        joined.canonicalize()?
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| AppError::PathEscape(rel.to_string()))?;
        let parent = parent
            .canonicalize()
            .map_err(|_| AppError::NotFound(rel.to_string()))?;
        parent.join(joined.file_name().unwrap_or_default())
    };
    if !anchor.starts_with(root) {
        return Err(AppError::PathEscape(rel.to_string()));
    }
    Ok(anchor)
}

/// Inverse of [`resolve_in_vault`]: an absolute path back to a `/`-separated
/// vault-relative one, or `None` if it lies outside.
pub fn to_rel(root: &Path, path: &Path) -> Option<String> {
    let stripped = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = stripped
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

// ---------------------------------------------------------------------------
// Recent vaults
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub path: String,
    pub name: String,
}

fn recents_file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("No app data directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("recent-vaults.json"))
}

pub fn read_recents(app: &AppHandle) -> Vec<RecentVault> {
    let Ok(file) = recents_file(app) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let mut recents: Vec<RecentVault> = serde_json::from_str(&raw).unwrap_or_default();
    // A vault the user has since deleted or unmounted should not be offered.
    recents.retain(|r| Path::new(&r.path).is_dir());
    recents
}

/// Moves `vault` to the front of the recents list, keeping the ten most recent.
pub fn push_recent(app: &AppHandle, vault: &Vault) -> Result<()> {
    let mut recents = read_recents(app);
    let path = vault.root.display().to_string();
    recents.retain(|r| r.path != path);
    recents.insert(
        0,
        RecentVault {
            path,
            name: vault.name.clone(),
        },
    );
    recents.truncate(10);
    std::fs::write(recents_file(app)?, serde_json::to_string_pretty(&recents)?)?;
    Ok(())
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kodigo-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn resolves_plain_relative_paths() {
        let root = temp_root();
        assert_eq!(
            resolve_in_vault(&root, "sub/new.md").unwrap(),
            root.join("sub/new.md")
        );
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let root = temp_root();
        assert!(resolve_in_vault(&root, "../outside.md").is_err());
        assert!(resolve_in_vault(&root, "sub/../../outside.md").is_err());
        assert!(resolve_in_vault(&root, "/etc/passwd").is_err());
    }

    #[test]
    fn round_trips_relative_paths() {
        let root = temp_root();
        let abs = resolve_in_vault(&root, "sub/a.md").unwrap();
        assert_eq!(to_rel(&root, &abs).as_deref(), Some("sub/a.md"));
    }

    #[test]
    fn recognises_note_files() {
        assert!(is_note_file(Path::new("a/b.MD")));
        assert!(!is_note_file(Path::new("a/b.png")));
        assert!(is_skipped(".hidden"));
        assert!(is_skipped("node_modules"));
    }
}
