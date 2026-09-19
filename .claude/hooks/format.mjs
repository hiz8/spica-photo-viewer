#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc"];

function parseInput(inputData) {
  try {
    return JSON.parse(inputData);
  } catch {
    return null;
  }
}

function hasValidExtension(filePath) {
  if (!filePath) {
    return false;
  }
  return SUPPORTED_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

function getNpxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function runOxfmtFormat(filePath) {
  const npxCommand = getNpxCommand();
  // Node >=20.12 refuses to spawn a .cmd shim without a shell (CVE-2024-27980),
  // so npx.cmd fails with EINVAL unless we opt in — and once cmd.exe parses the
  // line, the path has to carry its own quotes.
  const useShell = process.platform === "win32";
  const target = useShell ? `"${filePath}"` : filePath;
  const oxfmt = spawn(npxCommand, ["oxfmt", "--write", target], {
    stdio: "inherit",
    shell: useShell,
  });

  oxfmt.on("error", (err) => {
    console.error(`Failed to start oxfmt formatter: ${err?.message ?? err}`);
    process.exit(1);
  });

  oxfmt.on("close", (code) => {
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

  const filePath = data?.tool_input?.file_path ?? "";
  if (!hasValidExtension(filePath)) {
    process.exit(0);
  }

  runOxfmtFormat(filePath);
});
