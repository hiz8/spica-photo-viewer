import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dirname is not reliably populated depending on how wdio's TS
// loader evaluates this config, so derive it from import.meta.url instead.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Release binary produced by `npm run bench:build`
 * (= `tauri build --no-bundle --features e2e` with VITE_PERF_LOG=1).
 * Cargo names the exe after the [package] name in Cargo.toml, not after
 * tauri.conf.json's productName.
 */
export const appBinaryPath = join(
  here,
  "../src-tauri/target/release/spica-photo-viewer.exe",
);

// Runtime flag for the Rust-side perf logging in the launched app. Set at
// module scope rather than in onPrepare because wdio evaluates this file
// before any hook runs, and the service spawns the app from its own onPrepare
// - hook ordering between the two is not guaranteed. The embedded provider
// spawns with { ...process.env, ...options.env }, so this covers the app even
// if the service-level `env` option below ever stops being honoured.
process.env.SPICA_PERF = "1";

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,

  // The binary comes from the service-level `appBinaryPath` below; the
  // capability only has to declare the Tauri browser name.
  capabilities: [{ browserName: "tauri" }],

  services: [
    [
      "tauri",
      {
        appBinaryPath,
        // Embedded W3C server provided by tauri-plugin-wdio-webdriver, which is
        // compiled in only under the `e2e` cargo feature. No external
        // tauri-driver / msedgedriver process is involved.
        driverProvider: "embedded",
        // Merged into the spawned app's environment by the embedded provider,
        // which enables the Rust-side SPICA_PERF timing logs at runtime.
        env: { SPICA_PERF: "1" },
        startTimeout: 120_000,
        // NOTE: `captureBackendLogs: true` was tried and does NOT surface this
        // app's stdout/stderr in @wdio/tauri-service 1.3.0 + embedded provider
        // (not even startup lines). Harvesting the Rust SPICA_PERF JSON lines
        // will need its own mechanism. The lines themselves are fine: the app's
        // stderr is readable over an inherited pipe despite the release build's
        // windows_subsystem = "windows".
      },
    ],
  ],

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },

  logLevel: "warn",
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
};
