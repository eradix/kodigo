//! Command-line arguments.
//!
//! `kodigo ~/notes` opens that folder as a vault, and `--data-dir` puts the
//! recent-vault list and the search index somewhere other than the usual app
//! data directory, which is what makes a portable or throwaway profile possible.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Clone)]
pub struct Cli {
    /// A vault to open instead of the most recently used one.
    pub vault: Option<PathBuf>,
    /// Where to keep the recents list and the index.
    pub data_dir: Option<PathBuf>,
}

/// Parses the process arguments, ignoring anything unrecognised.
///
/// A desktop app is launched by desktop environments and webdrivers alike, and
/// they pass flags of their own; refusing to start over one would be worse than
/// quietly skipping it.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Cli {
    let mut cli = Cli::default();
    let mut args = args.into_iter().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--vault" => cli.vault = args.next().map(PathBuf::from),
            "--data-dir" => cli.data_dir = args.next().map(PathBuf::from),
            other if other.starts_with('-') => {}
            // A bare path is taken as the vault, so `kodigo ~/notes` works.
            other => {
                if cli.vault.is_none() {
                    cli.vault = Some(PathBuf::from(other));
                }
            }
        }
    }
    cli
}

/// The directory holding the recents list and the per-vault indexes.
pub fn data_dir(app: &AppHandle) -> crate::error::Result<PathBuf> {
    let dir = match app.try_state::<Cli>().and_then(|cli| cli.data_dir.clone()) {
        Some(dir) => dir,
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| crate::error::AppError::Other(format!("No app data directory: {e}")))?,
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Cli {
        parse(
            std::iter::once("kodigo".to_string())
                .chain(args.iter().map(|a| a.to_string()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn takes_a_bare_path_as_the_vault() {
        assert_eq!(
            parse_args(&["/home/me/notes"]).vault,
            Some(PathBuf::from("/home/me/notes"))
        );
    }

    #[test]
    fn reads_both_flags() {
        let cli = parse_args(&["--vault", "/notes", "--data-dir", "/tmp/profile"]);
        assert_eq!(cli.vault, Some(PathBuf::from("/notes")));
        assert_eq!(cli.data_dir, Some(PathBuf::from("/tmp/profile")));
    }

    #[test]
    fn ignores_flags_meant_for_somebody_else() {
        // WebDriver and desktop launchers add their own; none should stop start-up.
        let cli = parse_args(&["--remote-debugging-port=9222", "/notes"]);
        assert_eq!(cli.vault, Some(PathBuf::from("/notes")));
    }

    #[test]
    fn has_no_opinion_when_given_nothing() {
        let cli = parse_args(&[]);
        assert!(cli.vault.is_none() && cli.data_dir.is_none());
    }
}
