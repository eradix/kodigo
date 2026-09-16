import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import type { RecentVault } from "../lib/types";

interface Props {
  onPick: () => void;
  onOpen: (path: string) => void;
}

export function Welcome({ onPick, onOpen }: Props) {
  const [recents, setRecents] = useState<RecentVault[]>([]);

  useEffect(() => {
    let cancelled = false;
    ipc
      .recentVaults()
      .then((list) => !cancelled && setRecents(list))
      .catch(() => {
        // An unreadable recents file is not worth interrupting a first launch.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="welcome">
      <h1>Kodigo</h1>
      <p className="tagline">A folder of Markdown files, made searchable.</p>
      <button className="primary-button" onClick={onPick}>
        Open a folder as a vault
      </button>

      {recents.length > 0 && (
        <div className="recents">
          <h2>Recent</h2>
          {recents.map((recent) => (
            <button key={recent.path} className="recent-item" onClick={() => onOpen(recent.path)}>
              <span>{recent.name}</span>
              <span className="path">{recent.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
