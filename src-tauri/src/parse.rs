//! Markdown parsing: YAML frontmatter, title derivation and `#tag` extraction.
//!
//! Deliberately hand-rolled rather than pulled from a full Markdown parser: we only
//! need three facts per note, and the tag scanner has to understand code fences,
//! which a token stream would make no easier.

pub struct ParsedNote {
    pub title: String,
    /// Frontmatter re-encoded as JSON, or `None` when there is no usable block.
    pub frontmatter: Option<String>,
    /// Note content with the frontmatter block removed.
    pub body: String,
    pub tags: Vec<String>,
}

/// Splits a leading `---` block off the front of the file.
/// Returns `(yaml, rest)`; `yaml` is `None` when the file does not open with one.
pub fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let trimmed = content.strip_prefix('\u{feff}').unwrap_or(content);
    let after_open = match trimmed.strip_prefix("---\n") {
        Some(rest) => rest,
        None => match trimmed.strip_prefix("---\r\n") {
            Some(rest) => rest,
            None => return (None, trimmed),
        },
    };

    let mut offset = 0usize;
    for line in after_open.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare == "---" || bare == "..." {
            let yaml = &after_open[..offset];
            let rest = &after_open[offset + line.len()..];
            return (Some(yaml), rest);
        }
        offset += line.len();
    }
    // Unterminated block: treat the whole file as body rather than swallowing it.
    (None, trimmed)
}

/// Tags declared in frontmatter, accepting both `tags: [a, b]` and `tags: a, b`.
fn frontmatter_tags(value: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["tags", "tag"] {
        match value.get(key) {
            Some(serde_json::Value::Array(items)) => {
                for item in items {
                    if let Some(s) = item.as_str() {
                        out.push(s.trim().trim_start_matches('#').to_string());
                    }
                }
            }
            Some(serde_json::Value::String(s)) => {
                for part in s.split(',') {
                    out.push(part.trim().trim_start_matches('#').to_string());
                }
            }
            _ => {}
        }
    }
    out.retain(|t| !t.is_empty());
    out
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// Scans the body for `#tag`, skipping fenced blocks, inline code and URL fragments.
pub fn extract_inline_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;

    for line in body.lines() {
        let indent_trimmed = line.trim_start();

        // Fence tracking. A fence closes only on the same character and at least
        // as many of them, which is what CommonMark requires.
        let fence_char = indent_trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(c) = fence_char {
            let run = indent_trimmed.chars().take_while(|x| *x == c).count();
            if run >= 3 {
                match fence {
                    Some((open_c, open_run)) if open_c == c && run >= open_run => {
                        fence = None;
                        continue;
                    }
                    None => {
                        fence = Some((c, run));
                        continue;
                    }
                    _ => {}
                }
            }
        }
        if fence.is_some() {
            continue;
        }

        let chars: Vec<char> = line.chars().collect();
        let mut i = 0usize;
        let mut in_inline_code = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_inline_code = !in_inline_code;
                i += 1;
                continue;
            }
            if in_inline_code || c != '#' {
                i += 1;
                continue;
            }

            // A `#` glued to preceding text is a URL fragment or a colour, not a tag.
            let prev_ok = match i.checked_sub(1).map(|p| chars[p]) {
                None => true,
                Some(p) => p.is_whitespace() || matches!(p, '(' | '[' | '{' | ',' | ';' | '"' | '\''),
            };
            if !prev_ok {
                i += 1;
                continue;
            }

            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_tag_char(chars[end]) {
                end += 1;
            }
            let tag: String = chars[start..end].iter().collect();
            i = end.max(i + 1);

            // Reject headings (`# ` leaves an empty tag), bare numbers (`#1`) and
            // trailing separators (`#foo/`).
            if tag.is_empty() || tag.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let tag = tag.trim_end_matches(['-', '/']).to_string();
            if !tag.is_empty() {
                out.push(tag);
            }
        }
    }
    out
}

fn first_heading(body: &str) -> Option<String> {
    let mut fence: Option<char> = None;
    for line in body.lines() {
        let t = line.trim_start();
        if let Some(c) = t.chars().next().filter(|c| *c == '`' || *c == '~') {
            if t.chars().take_while(|x| *x == c).count() >= 3 {
                fence = if fence == Some(c) { None } else { Some(c) };
                continue;
            }
        }
        if fence.is_some() {
            continue;
        }
        if let Some(rest) = t.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

/// Derives every indexable fact about a note from its path and raw contents.
pub fn parse_note(rel_path: &str, content: &str) -> ParsedNote {
    let (yaml, body) = split_frontmatter(content);
    let fm: Option<serde_json::Value> = yaml
        .and_then(|y| serde_yaml_ng::from_str::<serde_json::Value>(y).ok())
        .filter(|v| v.is_object());

    let mut tags = fm.as_ref().map(frontmatter_tags).unwrap_or_default();
    tags.extend(extract_inline_tags(body));
    tags.sort_by_key(|t| t.to_lowercase());
    tags.dedup_by_key(|t| t.to_lowercase());

    let stem = rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(rel_path)
        .to_string();

    let title = fm
        .as_ref()
        .and_then(|v| v.get("title"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| first_heading(body))
        .unwrap_or(stem);

    ParsedNote {
        title,
        frontmatter: fm.map(|v| v.to_string()),
        body: body.to_string(),
        tags,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_frontmatter() {
        let (yaml, body) = split_frontmatter("---\ntitle: Hi\n---\nBody\n");
        assert_eq!(yaml, Some("title: Hi\n"));
        assert_eq!(body, "Body\n");
    }

    #[test]
    fn leaves_unterminated_frontmatter_as_body() {
        let (yaml, body) = split_frontmatter("---\ntitle: Hi\nstill going");
        assert!(yaml.is_none());
        assert!(body.starts_with("---"));
    }

    #[test]
    fn ignores_dashes_that_are_not_at_the_top() {
        let (yaml, _) = split_frontmatter("text\n---\ntitle: Hi\n---\n");
        assert!(yaml.is_none());
    }

    #[test]
    fn finds_inline_tags() {
        let tags = extract_inline_tags("a #rust and #web/dev here");
        assert_eq!(tags, vec!["rust", "web/dev"]);
    }

    #[test]
    fn skips_tags_in_code() {
        let tags = extract_inline_tags("```\n#notatag\n```\nreal #tag and `#alsonot`");
        assert_eq!(tags, vec!["tag"]);
    }

    #[test]
    fn skips_tildes_fences_and_headings_and_urls() {
        assert!(extract_inline_tags("~~~\n#nope\n~~~").is_empty());
        assert!(extract_inline_tags("# Heading").is_empty());
        assert!(extract_inline_tags("see https://x.dev/page#section").is_empty());
        assert!(extract_inline_tags("issue #42").is_empty());
    }

    #[test]
    fn title_prefers_frontmatter_then_heading_then_filename() {
        assert_eq!(parse_note("a/b.md", "---\ntitle: FM\n---\n# H\n").title, "FM");
        assert_eq!(parse_note("a/b.md", "# H\ntext").title, "H");
        assert_eq!(parse_note("a/b.md", "text").title, "b");
    }

    #[test]
    fn merges_frontmatter_and_inline_tags_without_duplicates() {
        let p = parse_note("n.md", "---\ntags: [rust, \"#web\"]\n---\n#rust #new\n");
        assert_eq!(p.tags, vec!["new", "rust", "web"]);
    }
}
