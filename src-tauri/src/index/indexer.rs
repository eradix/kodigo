//! Keeping the index in step with the folder: one-file updates and full scans.

use crate::error::Result;
use crate::parse::parse_note;
use crate::state::fingerprint;
use crate::vault::{is_note_file, is_skipped, to_rel};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub done: usize,
    pub total: usize,
}

/// Reads one note off disk and refreshes its row, full-text entry and tags.
pub fn index_file(conn: &Connection, root: &Path, rel: &str) -> Result<()> {
    let abs = root.join(rel);
    let Some((size, mtime)) = fingerprint(&abs) else {
        // Vanished between being listed and being read: treat it as a deletion.
        return remove_note(conn, rel);
    };
    let Ok(content) = std::fs::read_to_string(&abs) else {
        // Not UTF-8, so not something this app can edit or search.
        return remove_note(conn, rel);
    };

    let parsed = parse_note(rel, &content);
    let id: i64 = conn.query_row(
        "INSERT INTO notes(rel_path, title, mtime, size, frontmatter)
              VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(rel_path) DO UPDATE SET
              title = excluded.title, mtime = excluded.mtime,
              size = excluded.size, frontmatter = excluded.frontmatter
         RETURNING id",
        params![rel, parsed.title, mtime, size as i64, parsed.frontmatter],
        |row| row.get(0),
    )?;

    conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
    conn.execute(
        "INSERT INTO notes_fts(rowid, title, body) VALUES (?1, ?2, ?3)",
        params![id, parsed.title, parsed.body],
    )?;

    conn.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
    for tag in &parsed.tags {
        conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?1)", params![tag])?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id)
                  SELECT ?1, id FROM tags WHERE name = ?2",
            params![id, tag],
        )?;
    }
    Ok(())
}

pub fn remove_note(conn: &Connection, rel: &str) -> Result<()> {
    if let Ok(id) = conn.query_row(
        "SELECT id FROM notes WHERE rel_path = ?1",
        params![rel],
        |row| row.get::<_, i64>(0),
    ) {
        conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    }
    Ok(())
}

/// Forgets tags that no note references any more, so the tag panel stays honest.
pub fn prune_tags(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)",
        [],
    )?;
    Ok(())
}

/// Rescans the whole vault, touching only files whose size or mtime changed and
/// dropping rows for files that are gone. Emits `index://progress` as it goes.
pub fn index_all(app: &AppHandle, conn: &Connection, root: &Path) -> Result<usize> {
    let indexed = scan(conn, root, |done, total| {
        let _ = app.emit("index://progress", IndexProgress { done, total });
    })?;
    let total = conn
        .query_row("SELECT count(*) FROM notes", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0) as usize;
    let _ = app.emit("index://done", IndexProgress { done: total, total });
    Ok(indexed)
}

/// The scan itself, with progress reported through a callback so it can be
/// driven from a test as well as from a window.
pub fn scan(
    conn: &Connection,
    root: &Path,
    mut progress: impl FnMut(usize, usize),
) -> Result<usize> {
    let mut on_disk: Vec<(String, u64, i64)> = Vec::new();
    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        !entry
            .file_name()
            .to_str()
            .map(is_skipped)
            .unwrap_or(true)
    });
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() || !is_note_file(entry.path()) {
            continue;
        }
        if let (Some(rel), Some((size, mtime))) =
            (to_rel(root, entry.path()), fingerprint(entry.path()))
        {
            on_disk.push((rel, size, mtime));
        }
    }

    let mut known: HashMap<String, (u64, i64)> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT rel_path, size, mtime FROM notes")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows.flatten() {
            known.insert(row.0, (row.1, row.2));
        }
    }

    let total = on_disk.len();
    let tx = conn.unchecked_transaction()?;
    let mut indexed = 0usize;
    for (done, (rel, size, mtime)) in on_disk.iter().enumerate() {
        if known.remove(rel) != Some((*size, *mtime)) {
            index_file(conn, root, rel)?;
            indexed += 1;
        }
        if done % 200 == 0 {
            progress(done, total);
        }
    }
    // Anything still in `known` was not found on disk.
    for rel in known.keys() {
        remove_note(conn, rel)?;
    }
    prune_tags(conn)?;
    tx.commit()?;

    progress(total, total);
    Ok(indexed)
}

/// Drops every note beneath a folder. Used when a folder is renamed or trashed,
/// where the watcher may only report the folder itself.
pub fn remove_under(conn: &Connection, rel_dir: &str) -> Result<()> {
    let prefix = format!("{}/%", rel_dir.trim_end_matches('/'));
    let rels: Vec<String> = {
        let mut stmt = conn.prepare("SELECT rel_path FROM notes WHERE rel_path LIKE ?1")?;
        let rows: Vec<String> = stmt
            .query_map(params![prefix], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    for rel in rels {
        remove_note(conn, &rel)?;
    }
    prune_tags(conn)
}

/// Indexes every note beneath a folder, for the other half of a rename.
pub fn index_under(conn: &Connection, root: &Path, rel_dir: &str) -> Result<()> {
    let dir = root.join(rel_dir);
    for entry in WalkDir::new(&dir)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_str().map(is_skipped).unwrap_or(true))
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && is_note_file(entry.path()) {
            if let Some(rel) = to_rel(root, entry.path()) {
                index_file(conn, root, &rel)?;
            }
        }
    }
    Ok(())
}
