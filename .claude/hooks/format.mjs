import { spawn } from "child_process";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin });
let inputData = "";

rl.on("line", (line) => {
  inputData += line;
});

rl.on("close", () => {
  const data = JSON.parse(inputData);
  const filePath = data?.tool_input?.file_path ?? "";

  const supportedExtensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc"];
  const hasValidExtension = supportedExtensions.some((ext) =>
    filePath.endsWith(ext)
  );

  if (filePath && hasValidExtension) {
    const biome = spawn("npx", ["biome", "format", "--write", filePath], {
      stdio: "inherit",
      shell: true,
    });

    biome.on("close", (code) => {
      process.exit(code ?? 0);
    });
  }
});
