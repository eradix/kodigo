import { parentOf } from "../../lib/paths";
import { SidebarView, useStore } from "../../state/store";
import { FileTree } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { TagPanel } from "./TagPanel";

const VIEWS: { id: SidebarView; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "search", label: "Search" },
  { id: "tags", label: "Tags" },
];

export function Sidebar({ onSwitchVault }: { onSwitchVault: () => void }) {
  const vault = useStore((s) => s.vault);
  const view = useStore((s) => s.sidebarView);
  const setView = useStore((s) => s.setSidebarView);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  const createEntry = useStore((s) => s.createEntry);

  // Both create alongside the note you are in, matching Ctrl+N and the tree's
  // own context menu, rather than always landing at the vault root.
  const create = (kind: "note" | "folder") =>
    void createEntry(kind, parentOf(useStore.getState().activeRel));

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="vault-name" title={vault?.root}>
          {vault?.name}
        </span>
        <button className="icon-button" title="New note" onClick={() => create("note")}>
          +
        </button>
        <button
          className="icon-button"
          title="New folder"
          onClick={() => create("folder")}
        >
          {"\u{1F5C1}"}
        </button>
        <button className="icon-button" title="Open another vault" onClick={onSwitchVault}>
          &#9776;
        </button>
        <button
          className="icon-button"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={toggleTheme}
        >
          {theme === "dark" ? "☀" : "☽"}
        </button>
      </div>

      <div className="sidebar-views" role="tablist">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="sidebar-body">
        {view === "files" && <FileTree />}
        {view === "search" && <SearchPanel />}
        {view === "tags" && <TagPanel />}
      </div>
    </aside>
  );
}
