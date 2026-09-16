//! Bringing files dropped from the OS file manager into the vault.

use crate::error::Result;
use crate::notes::unique_in_dir;
use crate::vault::{is_note_file, is_skipped, resolve_in_vault, to_rel};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Vault-relative paths of the notes that landed, in drop order.
    pub imported: Vec<String>,
    /// Names that were not notes, reported back so the user is told rather than
    /// left wondering why half a drop disappeared.
    pub skipped: Vec<String>,
}

fn copy_note(root: &Path, dest_dir: &Path, source: &Path, result: &mut ImportResult) {
    let Some(file_name) = source.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return;
    };
    let target = unique_in_dir(dest_dir, &file_name);
    match std::fs::copy(source, &target) {
        Ok(_) => {
            if let Some(rel) = to_rel(root, &target) {
                result.imported.push(rel);
            }
        }
        Err(_) => result.skipped.push(file_name),
    }
}

/// Copies dropped files into `dest_rel`. Dropped folders bring their notes in
/// under a folder of the same name; nesting is not followed further, because a
/// drag-and-drop is a shallow gesture and a deep tree copy rarely is what was meant.
pub fn import_paths(root: &Path, dest_rel: &str, sources: &[String]) -> Result<ImportResult> {
    let dest_dir = resolve_in_vault(root, dest_rel)?;
    std::fs::create_dir_all(&dest_dir)?;

    let mut result = ImportResult::default();
    for source in sources {
        let source = PathBuf::from(source);
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if source.is_dir() {
            let folder = unique_in_dir(&dest_dir, &name);
            if std::fs::create_dir_all(&folder).is_err() {
                result.skipped.push(name);
                continue;
            }
            let mut found_any = false;
            if let Ok(entries) = std::fs::read_dir(&source) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let child = entry.path();
                    let child_name = entry.file_name().to_string_lossy().to_string();
                    if is_skipped(&child_name) || !child.is_file() {
                        continue;
                    }
                    if is_note_file(&child) {
                        copy_note(root, &folder, &child, &mut result);
                        found_any = true;
                    } else {
                        result.skipped.push(child_name);
                    }
                }
            }
            if !found_any {
                let _ = std::fs::remove_dir(&folder);
            }
        } else if is_note_file(&source) {
            copy_note(root, &dest_dir, &source, &mut result);
        } else if !name.is_empty() {
            result.skipped.push(name);
        }
    }
    Ok(result)
}
