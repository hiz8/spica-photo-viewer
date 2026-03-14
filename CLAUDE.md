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

## Critical Patterns

### Zustand Immutable Updates

Always use immutable updates in Zustand state. Never mutate state directly.

```typescript
set((state) => ({
  cache: {
    ...state.cache,
    imageViewStates: new Map(state.cache.imageViewStates).set(path, viewState)
  }
}))
```

### Image Loading Logic

- New images: Use `fitToWindow()` for initial display
- Returning to viewed images: Use `updateImageDimensions()` to preserve saved view state
- Check `cache.imageViewStates.has(path)` to determine which behavior to use

### Adding New Store Actions

1. Add action to `AppActions` interface
2. Implement in store with immutable updates
3. Update test mocks in `src/utils/testUtils.tsx`
4. Add unit tests in `src/store/__tests__/index.test.ts`

## Testing

- All tests must pass before committing
- Update test mocks when adding new store properties

## Project Specs

For detailed specifications, see [PROJECT_SPEC.md](./PROJECT_SPEC.md).
