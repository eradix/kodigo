import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createVault, publishVault, removeVault } from "./vault.js";

/**
 * Drives the real, compiled Kodigo binary through tauri-driver.
 *
 * Everything else in this repository tests logic in isolation; this is the only
 * suite that clicks and types. It exists because every bug that reached a user
 * so far lived in the gap between "the function is correct" and "the editor
 * behaves", which unit tests cannot see.
 */

const projectRoot = path.resolve(import.meta.dirname, "..");

const binary =
  process.env.KODIGO_BINARY ??
  path.join(projectRoot, "src-tauri/target/release/kodigo");

let driver;
let vault;

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: [path.join(import.meta.dirname, "specs/**/*.spec.js")],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": { application: binary },
    },
  ],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  // A cold start plus the first index pass is slower than the default.
  connectionRetryTimeout: 120_000,
  waitforTimeout: 15_000,
  mochaOpts: { ui: "bdd", timeout: 90_000 },

  onPrepare: () => {
    if (!fs.existsSync(binary)) {
      throw new Error(
        `No Kodigo binary at ${binary}.\n` +
          `Build one first (npm run build && cargo build --manifest-path src-tauri/Cargo.toml)\n` +
          `or point KODIGO_BINARY at an existing build.`,
      );
    }
    vault = createVault();

    driver = spawn("tauri-driver", [], {
      stdio: [null, process.stdout, process.stderr],
      env: {
        ...process.env,
        // Redirects the app's recent-vault list and search index into the
        // temporary directory, so the suite never touches real notes.
        XDG_DATA_HOME: vault.dataDir,
        // WebKitGTK's accelerated paths are unavailable on CI runners and
        // under WSL; without this the window never appears.
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      },
    });

    // Hand the specs the paths they need to check the filesystem directly,
    // which is how a test proves a note really was saved.
    publishVault(vault);
  },

  onComplete: () => {
    driver?.kill();
    if (vault) removeVault(vault.base);
  },
};
