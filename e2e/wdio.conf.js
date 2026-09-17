import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, VAULT_ROOT, removeVault, resetVault } from "./vault.js";

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

// WebdriverIO loads this file in the launcher and again in each worker. Only the
// launcher may build the vault; a worker rebuilding it would delete the notes a
// running test is in the middle of checking.
if (!process.env.WDIO_WORKER_ID) resetVault();

let driver;

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: [path.join(import.meta.dirname, "specs/**/*.spec.js")],
  maxInstances: 1,

  // Capabilities must be complete before WebdriverIO starts. Assigning them
  // from onPrepare is too late — the run aborts with "Missing capabilities" —
  // which is why the vault paths are fixed rather than invented per run.
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: binary,
        // The vault reaches the app as arguments rather than through the
        // environment: it is launched by WebKitWebDriver rather than directly,
        // and exported variables do not survive that hop.
        args: ["--vault", VAULT_ROOT, "--data-dir", DATA_DIR],
      },
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
          `Build one with: npm run tauri build -- --debug --no-bundle\n` +
          `then point KODIGO_BINARY at src-tauri/target/debug/kodigo.`,
      );
    }

    driver = spawn("tauri-driver", [], {
      stdio: [null, process.stdout, process.stderr],
      env: {
        ...process.env,
        // WebKitGTK's accelerated paths are unavailable on CI runners and
        // under WSL; without this the window never appears.
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      },
    });
  },

  onComplete: () => {
    driver?.kill();
    removeVault();
  },
};
