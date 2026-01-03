import { spawn } from "child_process";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin });
let inputData = "";

rl.on("line", (line) => {
  inputData += line;
});

rl.on("close", () => {
  let data;
  try {
    data = JSON.parse(inputData);
  } catch {
    process.exit(0);
  }

  const filePath = data?.tool_input?.file_path ?? "";
  const supportedExtensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc"];
  const hasValidExtension = supportedExtensions.some((ext) =>
    filePath.endsWith(ext)
  );

  if (!filePath || !hasValidExtension) {
    process.exit(0);
  }

  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const biome = spawn(npxCommand, ["biome", "format", "--write", filePath], {
    stdio: "inherit",
  });

  biome.on("error", (err) => {
    console.error("Failed to start biome formatter:", err?.message ?? err);
    process.exit(1);
  });

  biome.on("close", (code) => {
    process.exit(code ?? 0);
  });
});
