mod commands;
mod error;
mod import;
mod index;
mod notes;
mod parse;
mod state;
#[cfg(test)]
mod tests;
mod vault;
mod watcher;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::close_vault,
            commands::current_vault,
            commands::recent_vaults,
            commands::list_tree,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::rename_entry,
            commands::delete_entry,
            commands::import_paths,
            commands::search_notes,
            commands::quick_switch,
            commands::list_tags,
            commands::notes_by_tag,
            commands::reindex,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
