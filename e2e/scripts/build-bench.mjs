// Builds a release binary with perf instrumentation and the embedded
// WebDriver plugin enabled.
//
//   VITE_PERF_LOG=1  build-time flag  -> frontend perf marks + window.__SPICA_TEST__
//   --features e2e   build-time flag  -> tauri-plugin-wdio-webdriver (embedded W3C server)
//   SPICA_PERF=1     runtime flag     -> set by e2e/wdio.conf.ts when it spawns the app
//
// Output: src-tauri/target/release/spica-photo-viewer.exe (Windows).
import { execSync } from "node:child_process";

execSync("npm run tauri build -- --no-bundle --features e2e", {
  stdio: "inherit",
  env: { ...process.env, VITE_PERF_LOG: "1" },
});
