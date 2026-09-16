//! End-to-end tests over a real folder of notes and a real SQLite index.
//!
//! These live inside the crate rather than in `tests/` so the modules can stay
//! private; everything here goes through the same functions the IPC commands do,
//! with only the `AppHandle` (window events, app-data paths) left out.

use crate::index::search;
use crate::index::{indexer, SCHEMA};
use crate::notes;
use crate::vault::{self, Vault};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A throwaway vault directory that cleans itself up.
struct TempVault {
    root: PathBuf,
}

impl TempVault {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("kodigo-it-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        TempVault {
            root: root.canonicalize().unwrap(),
        }
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fresh_index() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

/// A vault with a representative spread of notes: frontmatter, nested folders,
/// code fences, and a file the app should ignore entirely.
fn sample_vault() -> (TempVault, Connection) {
    let vault = TempVault::new();
    vault.write(
        "welcome.md",
        "---\ntitle: Welcome\ntags: [meta]\n---\n\n# Welcome\n\nA #wip note about zarquon.\n\n```rust\n// #notatag lives in code\nfn main() {}\n```\n",
    );
    vault.write(
        "projects/kodigo.md",
        "# Kodigo project\n\nBuilt with Tauri and SQLite.\n\n#rust #tauri\n",
    );
    vault.write("daily/monday.md", "# Monday\n\nStand-up notes. #daily\n");
    vault.write("notes.txt", "A plain text note about zarquon too.\n");
    // Neither of these is a note, and neither should ever be indexed or listed.
    vault.write("image.png", "not really a png");
    vault.write(".hidden/secret.md", "# Secret\n\n#hidden\n");

    let conn = fresh_index();
    indexer::scan(&conn, vault.path(), |_, _| {}).unwrap();
    (vault, conn)
}

fn indexed_paths(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT rel_path FROM notes ORDER BY rel_path")
        .unwrap();
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    rows
}

#[test]
fn indexes_notes_and_ignores_everything_else() {
    let (_vault, conn) = sample_vault();
    assert_eq!(
        indexed_paths(&conn),
        vec![
            "daily/monday.md",
            "notes.txt",
            "projects/kodigo.md",
            "welcome.md"
        ]
    );
}

#[test]
fn finds_a_word_that_appears_in_one_note() {
    let (_vault, conn) = sample_vault();
    let hits = search::search(&conn, "zarquon", 10).unwrap();
    let paths: Vec<_> = hits.iter().map(|h| h.rel_path.as_str()).collect();
    assert_eq!(paths.len(), 2, "both notes mention it");
    assert!(paths.contains(&"welcome.md"));
    assert!(paths.contains(&"notes.txt"));
    assert!(
        hits[0].snippet.contains('\u{2}'),
        "matches should be delimited for the UI: {:?}",
        hits[0].snippet
    );
}

#[test]
fn search_matches_prefixes_and_survives_punctuation() {
    let (_vault, conn) = sample_vault();
    assert!(!search::search(&conn, "zarq", 10).unwrap().is_empty());
    // A query that is nothing but FTS5 operators must not be a syntax error.
    assert!(search::search(&conn, "\"* OR (", 10).is_ok());
}

#[test]
fn titles_come_from_frontmatter_or_the_first_heading() {
    let (_vault, conn) = sample_vault();
    let title = |rel: &str| -> String {
        conn.query_row(
            "SELECT title FROM notes WHERE rel_path = ?1",
            [rel],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(title("welcome.md"), "Welcome");
    assert_eq!(title("projects/kodigo.md"), "Kodigo project");
    assert_eq!(title("notes.txt"), "notes");
}

#[test]
fn collects_tags_from_frontmatter_and_body_but_not_from_code() {
    let (_vault, conn) = sample_vault();
    let tags: Vec<String> = search::list_tags(&conn)
        .unwrap()
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert!(tags.contains(&"meta".to_string()), "frontmatter tag");
    assert!(tags.contains(&"wip".to_string()), "inline tag");
    assert!(tags.contains(&"rust".to_string()));
    assert!(
        !tags.contains(&"notatag".to_string()),
        "a #tag inside a fence is not a tag: {tags:?}"
    );
    assert!(
        !tags.contains(&"hidden".to_string()),
        "hidden folders are not indexed at all"
    );

    let tagged = search::notes_by_tag(&conn, "rust").unwrap();
    assert_eq!(tagged.len(), 1);
    assert_eq!(tagged[0].rel_path, "projects/kodigo.md");
}

#[test]
fn quick_switcher_ranks_the_obvious_note_first() {
    let (_vault, conn) = sample_vault();
    let hits = search::quick_switch(&conn, "kodigo", 5).unwrap();
    assert_eq!(hits[0].rel_path, "projects/kodigo.md");
}

#[test]
fn rescanning_only_touches_changed_files() {
    let (vault, conn) = sample_vault();
    assert_eq!(
        indexer::scan(&conn, vault.path(), |_, _| {}).unwrap(),
        0,
        "nothing changed, so nothing should be re-read"
    );

    // Sleep past the one-second resolution of the mtime fingerprint.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    vault.write("daily/monday.md", "# Monday\n\nRewritten. #daily #urgent\n");
    assert_eq!(indexer::scan(&conn, vault.path(), |_, _| {}).unwrap(), 1);

    let tags: Vec<String> = search::list_tags(&conn)
        .unwrap()
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert!(tags.contains(&"urgent".to_string()));
}

#[test]
fn deleting_a_file_drops_it_and_its_orphaned_tags() {
    let (vault, conn) = sample_vault();
    std::fs::remove_file(vault.path().join("projects/kodigo.md")).unwrap();
    indexer::scan(&conn, vault.path(), |_, _| {}).unwrap();

    assert!(!indexed_paths(&conn).contains(&"projects/kodigo.md".to_string()));
    let tags: Vec<String> = search::list_tags(&conn)
        .unwrap()
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert!(!tags.contains(&"tauri".to_string()), "orphan tag pruned");
}

#[test]
fn renaming_a_folder_moves_its_notes_in_the_index() {
    let (vault, conn) = sample_vault();
    std::fs::rename(vault.path().join("projects"), vault.path().join("work")).unwrap();
    indexer::remove_under(&conn, "projects").unwrap();
    indexer::index_under(&conn, vault.path(), "work").unwrap();

    let paths = indexed_paths(&conn);
    assert!(paths.contains(&"work/kodigo.md".to_string()));
    assert!(!paths.contains(&"projects/kodigo.md".to_string()));
}

#[test]
fn tree_lists_folders_first_and_hides_non_notes() {
    let (vault, _conn) = sample_vault();
    let tree = notes::build_tree(vault.path(), vault.path()).unwrap();
    let names: Vec<_> = tree.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, vec!["daily", "projects", "notes.txt", "welcome.md"]);
    assert_eq!(tree[0].children.as_ref().unwrap().len(), 1);
}

#[test]
fn writes_are_atomic_and_leave_no_temp_files_behind() {
    let vault = TempVault::new();
    vault.write("note.md", "original");
    notes::write_note(vault.path(), "note.md", "updated").unwrap();

    assert_eq!(
        std::fs::read_to_string(vault.path().join("note.md")).unwrap(),
        "updated"
    );
    let leftovers: Vec<_> = std::fs::read_dir(vault.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("kodigo-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "left behind {leftovers:?}");
}

#[test]
fn importing_skips_non_notes_and_never_overwrites() {
    let source = TempVault::new();
    source.write("guide.md", "# Guide\n");
    source.write("photo.jpg", "binary-ish");
    source.write("bundle/inner.md", "# Inner\n");

    let vault = TempVault::new();
    vault.write("guide.md", "# The existing guide\n");

    let result = crate::import::import_paths(
        vault.path(),
        "",
        &[
            source.path().join("guide.md").display().to_string(),
            source.path().join("photo.jpg").display().to_string(),
            source.path().join("bundle").display().to_string(),
        ],
    )
    .unwrap();

    assert_eq!(result.imported, vec!["guide 2.md", "bundle/inner.md"]);
    assert_eq!(result.skipped, vec!["photo.jpg"]);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("guide.md")).unwrap(),
        "# The existing guide\n",
        "the existing note must be untouched"
    );
}

#[test]
fn a_vault_gets_a_stable_id_from_its_path() {
    let dir = TempVault::new();
    let first = Vault::open(dir.path()).unwrap();
    let second = Vault::open(dir.path()).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.name, dir.path().file_name().unwrap().to_string_lossy());
}

#[test]
fn a_symlink_pointing_out_of_the_vault_is_refused() {
    let outside = TempVault::new();
    outside.write("secret.md", "# Secret\n");
    let vault = TempVault::new();

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();
        let resolved = vault::resolve_in_vault(vault.path(), "escape/secret.md");
        assert!(
            resolved.is_err(),
            "following a symlink out of the vault must fail, got {resolved:?}"
        );
    }
}
