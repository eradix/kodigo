//! Querying the index: full-text search, the quick switcher, and tags.

use crate::error::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel_path: String,
    pub title: String,
    /// Body excerpt with matches delimited by U+0002/U+0003. Control characters
    /// rather than `<mark>` tags: the excerpt is raw note text, and handing the
    /// webview markup built from it would make any note able to inject HTML.
    pub snippet: String,
    pub score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub rel_path: String,
    pub title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

/// Rewrites free text into a safe FTS5 query.
///
/// User input goes nowhere near MATCH directly: a stray quote or `*` is a syntax
/// error, and operators like `NEAR` would surprise someone just typing words.
/// Each word becomes a quoted prefix term, so "rust asy" finds "rust async".
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

pub fn search(conn: &Connection, input: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let Some(query) = fts_query(input) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT n.rel_path, n.title,
                snippet(notes_fts, 1, char(2), char(3), '…', 14),
                bm25(notes_fts, 4.0, 1.0)
           FROM notes_fts
           JOIN notes n ON n.id = notes_fts.rowid
          WHERE notes_fts MATCH ?1
       ORDER BY bm25(notes_fts, 4.0, 1.0)
          LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(params![query, limit as i64], |row| {
            Ok(SearchHit {
                rel_path: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                score: row.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(hits)
}

/// Subsequence match with bonuses for consecutive hits and word starts.
/// Returns `None` when `needle` is not a subsequence of `haystack` at all.
fn fuzzy_score(haystack: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let hay: Vec<char> = haystack.to_lowercase().chars().collect();
    let pat: Vec<char> = needle.to_lowercase().chars().collect();

    let mut score = 0i32;
    let mut pat_idx = 0usize;
    let mut last_match: Option<usize> = None;
    for (i, c) in hay.iter().enumerate() {
        if pat_idx >= pat.len() || *c != pat[pat_idx] {
            continue;
        }
        score += 1;
        if last_match == Some(i.wrapping_sub(1)) {
            score += 8;
        }
        let at_word_start = i == 0
            || hay
                .get(i - 1)
                .map(|p| matches!(p, '/' | '-' | '_' | ' ' | '.'))
                .unwrap_or(false);
        if at_word_start {
            score += 10;
        }
        last_match = Some(i);
        pat_idx += 1;
    }
    if pat_idx != pat.len() {
        return None;
    }
    // Shorter candidates win ties: "todo.md" should beat "archive/old-todo.md".
    Some(score - (hay.len() as i32 / 8))
}

/// Ranks notes by name for the Ctrl+O switcher. Matches the title first and only
/// falls back to the path, so folder names cannot outrank a real title match.
pub fn quick_switch(conn: &Connection, input: &str, limit: usize) -> Result<Vec<NoteRef>> {
    let mut stmt = conn.prepare("SELECT rel_path, title FROM notes")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut scored: Vec<(i32, NoteRef)> = rows
        .into_iter()
        .filter_map(|(rel_path, title)| {
            let by_title = fuzzy_score(&title, input).map(|s| s + 12);
            let by_path = fuzzy_score(&rel_path, input);
            let score = by_title.into_iter().chain(by_path).max()?;
            Some((score, NoteRef { rel_path, title }))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
    scored.truncate(limit);
    Ok(scored.into_iter().map(|(_, n)| n).collect())
}

pub fn list_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT t.name, count(nt.note_id) AS c
           FROM tags t
           JOIN note_tags nt ON nt.tag_id = t.id
       GROUP BY t.id
       ORDER BY c DESC, t.name COLLATE NOCASE ASC",
    )?;
    let tags = stmt
        .query_map([], |row| {
            Ok(TagCount {
                name: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

pub fn notes_by_tag(conn: &Connection, tag: &str) -> Result<Vec<NoteRef>> {
    let mut stmt = conn.prepare(
        "SELECT n.rel_path, n.title
           FROM notes n
           JOIN note_tags nt ON nt.note_id = n.id
           JOIN tags t ON t.id = nt.tag_id
          WHERE t.name = ?1 COLLATE NOCASE
       ORDER BY n.title COLLATE NOCASE",
    )?;
    let notes = stmt
        .query_map(params![tag], |row| {
            Ok(NoteRef {
                rel_path: row.get(0)?,
                title: row.get(1)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_prefix_queries_and_neutralises_operators() {
        assert_eq!(fts_query("rust async"), Some("\"rust\"* \"async\"*".into()));
        assert_eq!(fts_query("a OR b"), Some("\"a\"* \"OR\"* \"b\"*".into()));
        assert_eq!(fts_query("\"x*"), Some("\"x\"*".into()));
        assert!(fts_query("   ?! ").is_none());
    }

    #[test]
    fn fuzzy_requires_all_characters() {
        assert!(fuzzy_score("meeting notes", "mn").is_some());
        assert!(fuzzy_score("meeting notes", "mz").is_none());
    }

    #[test]
    fn fuzzy_prefers_word_starts_and_short_paths() {
        let direct = fuzzy_score("todo.md", "todo").unwrap();
        let buried = fuzzy_score("archive/old-todo.md", "todo").unwrap();
        assert!(direct > buried, "{direct} should beat {buried}");
    }
}
