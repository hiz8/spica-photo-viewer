#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.jsonc'];

function debugLog(message) {
  if (process.env.DEBUG) {
    console.error(message);
  }
}

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
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function runBiomeFormat(filePath) {
  const npxCommand = getNpxCommand();
  const biome = spawn(npxCommand, ['biome', 'format', '--write', filePath], {
    stdio: 'inherit',
  });

  biome.on('error', (err) => {
    console.error(`Failed to start biome formatter: ${err?.message ?? err}`);
    process.exit(1);
  });

  biome.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

const rl = createInterface({ input: process.stdin });
let inputData = '';

rl.on('line', (line) => {
  inputData += line;
});

rl.on('close', () => {
  const data = parseInput(inputData);
  if (data === null) {
    process.exit(0);
  }

  const filePath = data?.tool_input?.file_path ?? '';
  if (!hasValidExtension(filePath)) {
    process.exit(0);
  }

  runBiomeFormat(filePath);
});
