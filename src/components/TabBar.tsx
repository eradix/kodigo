import { useStore } from "../state/store";

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeRel = useStore((s) => s.activeRel);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.relPath}
          role="tab"
          aria-selected={tab.relPath === activeRel}
          className={`tab${tab.relPath === activeRel ? " active" : ""}`}
          title={tab.relPath}
          onClick={() => setActive(tab.relPath)}
          onAuxClick={(e) => {
            // Middle-click closes, as in every other tabbed editor.
            if (e.button === 1) closeTab(tab.relPath);
          }}
        >
          {tab.dirty && <span className="dot" title="Unsaved changes" />}
          <span className="name">{tab.title}</span>
          <span
            className="close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.relPath);
            }}
          >
            &times;
          </span>
        </div>
      ))}
    </div>
  );
}
