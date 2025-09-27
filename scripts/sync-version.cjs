#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function syncVersions() {
  try {
    // Read version from package.json (master source)
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const version = packageJson.version;

    console.log(`Syncing version: ${version}`);

    // Update tauri.conf.json
    const tauriConfPath = path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json');
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    tauriConf.version = version;
    fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
    console.log(`✓ Updated tauri.conf.json to version ${version}`);

    // Update Cargo.toml
    const cargoTomlPath = path.join(__dirname, '..', 'src-tauri', 'Cargo.toml');
    let cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
    cargoContent = cargoContent.replace(
      /(\[package\][^\[]*?)^version = ".*"$/m,
      (_, prefix) => `${prefix}version = "${version}"`
    );
    fs.writeFileSync(cargoTomlPath, cargoContent);
    console.log(`✓ Updated Cargo.toml to version ${version}`);

    console.log('Version sync completed successfully!');
  } catch (error) {
    console.error('Error syncing versions:', error);
    process.exit(1);
  }
}

syncVersions();