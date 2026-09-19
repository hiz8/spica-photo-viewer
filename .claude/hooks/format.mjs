#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const OXFMT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc"];
const RUST_EXTENSIONS = [".rs"];

// Keep in sync with `edition` in src-tauri/Cargo.toml: rustfmt invoked on a
// bare file assumes edition 2015 and mis-parses this crate's 2021 syntax.
const RUST_EDITION = "2021";

function parseInput(inputData) {
  try {
    return JSON.parse(inputData);
  } catch {
    return null;
  }
}

function matches(filePath, extensions) {
  return extensions.some((ext) => filePath.endsWith(ext));
}

function formatterFor(filePath) {
  if (!filePath) {
    return null;
  }
  if (matches(filePath, OXFMT_EXTENSIONS)) {
    // Node >=20.12 refuses to spawn a .cmd shim without a shell (CVE-2024-27980),
    // so npx.cmd fails with EINVAL unless we opt in — and once cmd.exe parses the
    // line, the path has to carry its own quotes.
    const useShell = process.platform === "win32";
    return {
      name: "oxfmt",
      command: useShell ? "npx.cmd" : "npx",
      args: ["oxfmt", "--write", useShell ? `"${filePath}"` : filePath],
      useShell,
    };
  }
  if (matches(filePath, RUST_EXTENSIONS)) {
    // rustfmt ships as a native executable, so it needs neither the shell nor
    // the quoting the npx.cmd shim above forces on us.
    return {
      name: "rustfmt",
      command: "rustfmt",
      args: ["--edition", RUST_EDITION, filePath],
      useShell: false,
    };
  }
  return null;
}

function runFormatter(formatter) {
  const child = spawn(formatter.command, formatter.args, {
    stdio: "inherit",
    shell: formatter.useShell,
  });

  child.on("error", (err) => {
    console.error(
      `Failed to start ${formatter.name} formatter: ${err?.message ?? err}`,
    );
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

const rl = createInterface({ input: process.stdin });
let inputData = "";

rl.on("line", (line) => {
  inputData += line;
});

rl.on("close", () => {
  const data = parseInput(inputData);
  if (data === null) {
    process.exit(0);
  }

  const formatter = formatterFor(data?.tool_input?.file_path ?? "");
  if (formatter === null) {
    process.exit(0);
  }

  runFormatter(formatter);
});
