//! The search index: a disposable SQLite cache of what is in the vault.
//!
//! The Markdown files are always the source of truth. Nothing here is unique —
//! deleting the database simply forces a full rescan on next open, which is also
//! how a schema change is handled.

pub mod indexer;
pub mod search;

use crate::error::Result;
use crate::vault::Vault;
use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Bump to force every existing index to be rebuilt from scratch.
const SCHEMA_VERSION: i64 = 1;

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE notes (
  id           INTEGER PRIMARY KEY,
  rel_path     TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  frontmatter  TEXT
);
CREATE INDEX notes_rel_path ON notes(rel_path);

-- rowid is kept equal to notes.id so the two can be joined directly.
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);
CREATE INDEX note_tags_tag ON note_tags(tag_id);

-- Unused in v1. It exists now so that adding [[wikilinks]] later is a feature,
-- not a migration plus a full reindex of every vault.
CREATE TABLE links (
  source_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  target_id   INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  pos         INTEGER
);
CREATE INDEX links_source ON links(source_id);
CREATE INDEX links_target ON links(target_path);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;

fn index_path(app: &AppHandle, vault: &Vault) -> Result<PathBuf> {
    // Lives in app data, not in the vault: the user's notes folder stays clean and
    // syncable, and a stale index never travels with it.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::AppError::Other(format!("No app data directory: {e}")))?
        .join("vaults")
        .join(&vault.id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("index.db"))
}

/// Opens (creating or rebuilding as needed) the index for `vault`.
pub fn open_index(app: &AppHandle, vault: &Vault) -> Result<Connection> {
    let path = index_path(app, vault)?;
    let conn = Connection::open(&path)?;
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;

    let version: i64 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    if version != SCHEMA_VERSION {
        // Rebuilding beats migrating: the whole database is derived data, and a
        // rescan of a personal vault takes well under a second.
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path)?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('schema_version', ?1), ('vault_path', ?2)",
            rusqlite::params![SCHEMA_VERSION.to_string(), vault.root.display().to_string()],
        )?;
        return Ok(conn);
    }
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn bundled_sqlite_has_fts5() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SCHEMA)
            .expect("schema needs FTS5 support in the bundled SQLite");
        conn.execute(
            "INSERT INTO notes_fts(rowid, title, body) VALUES (1, 'Hello', 'world of rust')",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'rust'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
