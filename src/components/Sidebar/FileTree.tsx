import { useEffect, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
import { ancestorsOf } from "../../lib/paths";
import type { TreeNode } from "../../lib/types";
import { useStore } from "../../state/store";

/** Which node the context menu is for, and where to draw it. */
interface MenuTarget {
  node: TreeNode | null;
  x: number;
  y: number;
}

interface TreeRowProps {
  node: TreeNode;
  expanded: Set<string>;
  onToggle: (relPath: string) => void;
  renaming: string | null;
  onRename: (node: TreeNode, name: string) => void;
  onCancelRename: () => void;
  onMenu: (target: MenuTarget) => void;
}

function TreeRow({
  node,
  expanded,
  onToggle,
  renaming,
  onRename,
  onCancelRename,
  onMenu,
}: TreeRowProps) {
  const activeRel = useStore((s) => s.activeRel);
  const openTab = useStore((s) => s.openTab);
  const rowRef = useRef<HTMLButtonElement>(null);
  const isActive = activeRel === node.relPath;

  // Follow the selection when it is moved from elsewhere — a search hit, the
  // quick switcher, a freshly created note.
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [isActive]);

  const contextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu({ node, x: e.clientX, y: e.clientY });
  };

  if (renaming === node.relPath) {
    return (
      <RenameInput
        initial={node.name}
        onCommit={(name) => onRename(node, name)}
        onCancel={onCancelRename}
      />
    );
  }

  if (node.isDir) {
    const open = expanded.has(node.relPath);
    return (
      <div>
        <button
          className="tree-row"
          onClick={() => onToggle(node.relPath)}
          onContextMenu={contextMenu}
          title={node.relPath}
        >
          <span className={`chevron${open ? " open" : ""}`}>&rsaquo;</span>
          <span className="label">{node.name}</span>
        </button>
        {open && (
          <div className="tree-children">
            {(node.children ?? []).map((child) => (
              <TreeRow
                key={child.relPath}
                node={child}
                expanded={expanded}
                onToggle={onToggle}
                renaming={renaming}
                onRename={onRename}
                onCancelRename={onCancelRename}
                onMenu={onMenu}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      ref={rowRef}
      className={`tree-row${isActive ? " selected" : ""}`}
      onClick={() => openTab(node.relPath)}
      onContextMenu={contextMenu}
      title={node.relPath}
    >
      <span className="chevron" />
      <span className="label">{node.name}</span>
    </button>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the stem only, so typing replaces the name but keeps the extension.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <input
      ref={ref}
      className="panel-input"
      style={{ margin: "1px 0" }}
      defaultValue={initial}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

export function FileTree() {
  const tree = useStore((s) => s.tree);
  const activeRel = useStore((s) => s.activeRel);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Open whatever folders are needed to show the active note. Folders the user
  // opened by hand stay open; this only ever adds.
  useEffect(() => {
    if (!activeRel) return;
    const needed = ancestorsOf(activeRel);
    if (needed.length === 0) return;
    setExpanded((current) => {
      const missing = needed.filter((folder) => !current.has(folder));
      if (missing.length === 0) return current;
      const next = new Set(current);
      for (const folder of missing) next.add(folder);
      return next;
    });
  }, [activeRel]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const toggle = (relPath: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(relPath)) next.add(relPath);
      return next;
    });

  const store = useStore.getState;

  const commitRename = async (node: TreeNode, name: string) => {
    setRenaming(null);
    if (!name.trim() || name === node.name) return;
    try {
      const newRel = await ipc.renameEntry(node.relPath, name.trim());
      store().renameTab(node.relPath, newRel);
      await store().refreshTree();
    } catch (e) {
      store().toast(ipc.errorMessage(e), "error");
    }
  };

  const remove = async (node: TreeNode) => {
    try {
      await ipc.deleteEntry(node.relPath);
      store().closeTab(node.relPath);
      await store().refreshTree();
      store().toast(`"${node.name}" moved to the trash`);
    } catch (e) {
      store().toast(ipc.errorMessage(e), "error");
    }
  };

  const create = async (parentRel: string, kind: "note" | "folder") => {
    try {
      const name = kind === "note" ? "Untitled" : "New folder";
      const rel =
        kind === "note"
          ? await ipc.createNote(parentRel, name)
          : await ipc.createFolder(parentRel, name);
      await store().refreshTree();
      if (parentRel) setExpanded((current) => new Set(current).add(parentRel));
      if (kind === "note") store().openTab(rel);
      // Drop straight into renaming it: a note called "Untitled" is never the goal.
      setRenaming(rel);
    } catch (e) {
      store().toast(ipc.errorMessage(e), "error");
    }
  };

  if (tree.length === 0) {
    return (
      <p className="empty-state">
        This vault has no notes yet. Use <strong>+</strong> above to create one, or drop
        Markdown files onto the window.
      </p>
    );
  }

  return (
    <div
      onContextMenu={(e) => {
        // Right-clicking empty space acts on the vault root.
        e.preventDefault();
        setMenu({ node: null, x: e.clientX, y: e.clientY });
      }}
      style={{ minHeight: "100%" }}
    >
      {tree.map((node) => (
        <TreeRow
          key={node.relPath}
          node={node}
          expanded={expanded}
          onToggle={toggle}
          renaming={renaming}
          onRename={(n, name) => void commitRename(n, name)}
          onCancelRename={() => setRenaming(null)}
          onMenu={setMenu}
        />
      ))}

      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(!menu.node || menu.node.isDir) && (
            <>
              <button onClick={() => void create(menu.node?.relPath ?? "", "note")}>
                New note
              </button>
              <button onClick={() => void create(menu.node?.relPath ?? "", "folder")}>
                New folder
              </button>
            </>
          )}
          {menu.node && (
            <>
              <button
                onClick={() => {
                  setRenaming(menu.node!.relPath);
                  setMenu(null);
                }}
              >
                Rename
              </button>
              <button className="danger" onClick={() => void remove(menu.node!)}>
                Move to trash
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
