//! Filesystem operations on the vault: the tree, and reading/writing notes.

use crate::error::{AppError, Result};
use crate::vault::{is_note_file, is_skipped, resolve_in_vault};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub children: Option<Vec<TreeNode>>,
}

/// Builds the sidebar tree: folders first, then notes, each case-insensitively
/// sorted. Hidden and tooling directories are skipped, as everywhere else.
pub fn build_tree(dir: &Path, root: &Path) -> Result<Vec<TreeNode>> {
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    for entry in std::fs::read_dir(dir)?.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_skipped(&name) {
            continue;
        }
        let path = entry.path();
        let Some(rel_path) = crate::vault::to_rel(root, &path) else {
            continue;
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            dirs.push(TreeNode {
                name,
                rel_path,
                is_dir: true,
                children: Some(build_tree(&path, root)?),
            });
        } else if is_note_file(&path) {
            files.push(TreeNode {
                name,
                rel_path,
                is_dir: false,
                children: None,
            });
        }
    }

    let by_name = |a: &TreeNode, b: &TreeNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    Ok(dirs)
}

/// Rejects names that would move the file elsewhere or break the filesystem.
pub fn validate_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with('.')
        || trimmed.contains(['/', '\\', '\0'])
    {
        return Err(AppError::InvalidName(name.to_string()));
    }
    Ok(())
}

/// Appends `.md` unless the name already ends in a recognised note extension.
pub fn with_note_extension(name: &str) -> String {
    if is_note_file(Path::new(name)) {
        name.to_string()
    } else {
        format!("{name}.md")
    }
}

/// Finds a free filename in `dir`, appending ` 2`, ` 3`, … as needed. Used for
/// new notes and for imports so a drop never overwrites an existing note.
pub fn unique_in_dir(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (file_name.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem} {n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(file_name)
}

pub fn read_note(root: &Path, rel: &str) -> Result<String> {
    let path = resolve_in_vault(root, rel)?;
    if !path.is_file() {
        return Err(AppError::NotFound(rel.to_string()));
    }
    Ok(std::fs::read_to_string(path)?)
}

/// Writes via a temporary file and a rename, so an interrupted save can never
/// leave a half-written note on disk. The temp name is dotted, which keeps it out
/// of the tree, the indexer and the watcher.
pub fn write_note(root: &Path, rel: &str, content: &str) -> Result<PathBuf> {
    let path = resolve_in_vault(root, rel)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidName(rel.to_string()))?;
    std::fs::create_dir_all(parent)?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".into());
    let tmp = parent.join(format!(".{file_name}.kodigo-tmp"));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}
