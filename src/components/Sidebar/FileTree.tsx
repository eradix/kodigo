import { useEffect, useRef, useState } from "react";
import * as ipc from "../../lib/ipc";
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
  renaming: string | null;
  onRename: (node: TreeNode, name: string) => void;
  onCancelRename: () => void;
  onMenu: (target: MenuTarget) => void;
}

function TreeRow({ node, renaming, onRename, onCancelRename, onMenu }: TreeRowProps) {
  const activeRel = useStore((s) => s.activeRel);
  const openTab = useStore((s) => s.openTab);
  const [open, setOpen] = useState(false);

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
    return (
      <div>
        <button
          className="tree-row"
          onClick={() => setOpen((v) => !v)}
          onContextMenu={contextMenu}
          title={node.relPath}
        >
          <span className={`chevron${open ? " open" : ""}`}>›</span>
          <span className="label">{node.name}</span>
        </button>
        {open && (
          <div className="tree-children">
            {(node.children ?? []).map((child) => (
              <TreeRow
                key={child.relPath}
                node={child}
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
      className={`tree-row${activeRel === node.relPath ? " selected" : ""}`}
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
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

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
