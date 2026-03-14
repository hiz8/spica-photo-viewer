# CLAUDE.md

## Commands

```bash
npm run tauri dev          # Start frontend + backend dev server
npm test                   # Run all tests (must pass before committing)
npm run type-check         # TypeScript type checking
npm run lint:fix           # Auto-fix lint issues (Biome)
npm run format:fix         # Auto-fix formatting (Biome)
npm run sync-version       # Sync version from package.json to Cargo.toml and tauri.conf.json

# Rust backend tests
cd src-tauri && cargo test --lib
cd src-tauri && cargo test commands::file::tests  # Run specific test module
```

## Code Style

- Biome for linting and formatting (not ESLint/Prettier)
- Run `npm run lint:fix` and `npm run format:fix` before committing

## Testing

- All tests must pass before committing

## Project Specs

For detailed specifications, see [PROJECT_SPEC.md](./PROJECT_SPEC.md).
