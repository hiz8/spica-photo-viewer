import { spawn } from "child_process";
import { createInterface } from "readline";

// stdin から JSON を読み込み
const rl = createInterface({ input: process.stdin });
let inputData = "";

rl.on("line", (line) => {
  inputData += line;
});

rl.on("close", () => {
  const data = JSON.parse(inputData);
  const filePath = data?.tool_input?.file_path ?? "";

  // biome が対応するファイル拡張子
  const supportedExtensions = [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc"];
  const hasValidExtension = supportedExtensions.some((ext) =>
    filePath.endsWith(ext)
  );

  if (filePath && hasValidExtension) {
    // biome format を実行
    const biome = spawn("npx", ["biome", "format", "--write", filePath], {
      stdio: "inherit",
      shell: true,
    });

    biome.on("close", (code) => {
      process.exit(code ?? 0);
    });
  }
});
