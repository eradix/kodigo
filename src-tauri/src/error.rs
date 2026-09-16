use serde::{Serialize, Serializer};

/// Every failure that can cross the IPC boundary. Serializes to a plain string so
/// the frontend can drop it straight into a toast.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("No vault is open")]
    NoVault,
    #[error("\"{0}\" is outside the vault")]
    PathEscape(String),
    #[error("\"{0}\" does not exist")]
    NotFound(String),
    #[error("\"{0}\" already exists")]
    AlreadyExists(String),
    #[error("\"{0}\" is not a valid name")]
    InvalidName(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<trash::Error> for AppError {
    fn from(e: trash::Error) -> Self {
        AppError::Other(format!("Could not move to trash: {e}"))
    }
}

impl From<notify::Error> for AppError {
    fn from(e: notify::Error) -> Self {
        AppError::Other(format!("File watcher error: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
