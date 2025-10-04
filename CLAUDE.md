# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start for Claude Code

### Essential Commands
```bash
# Development
npm run tauri dev     # Start development (frontend + backend)
npm test              # Run all tests (must pass all 137 tests)
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run type-check    # TypeScript type checking

# Backend testing
cd src-tauri && cargo test --lib
cd src-tauri && cargo test commands::file::tests     # Run specific test module
cd src-tauri && cargo test utils::image::tests       # Run specific test module
cd src-tauri && cargo test -- --nocapture           # Run tests with output

# Version management
npm run sync-version  # Sync version from package.json to Cargo.toml and tauri.conf.json
npm version patch     # Update version (patch/minor/major) then run sync-version

# Build
npm run tauri build   # Production build with MSI installer (outputs to src-tauri/target/release/bundle/msi/)
```

### Architecture Overview
- **Frontend**: React 19 + TypeScript + Zustand (state management)
- **Backend**: Tauri v2 + Rust (file operations, image processing)
- **Supported Formats**: JPEG, PNG, WebP, GIF (with animation)
- **Key Files**:
  - `src/components/ImageViewer.tsx` - Main image display component
  - `src/store/index.ts` - Zustand store with image view state persistence
  - `src-tauri/src/commands/` - Rust backend commands for file/image operations
- **Version Management**: `package.json` is master source, auto-synced to `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`

### Critical Implementation Patterns

#### Zustand State Management
- **ALWAYS use immutable updates** - Never mutate state directly
- View states persist per-image using `cache.imageViewStates` Map
- Example of correct state update:
```typescript
set((state) => ({
  cache: {
    ...state.cache,
    imageViewStates: new Map(state.cache.imageViewStates).set(path, viewState)
  }
}))
```

#### Image Loading Logic
- New images: Use `fitToWindow()` for initial display
- Returning to viewed images: Use `updateImageDimensions()` to preserve saved view state
- Check `cache.imageViewStates.has(path)` to determine which behavior to use

#### Testing Requirements
- All 137 tests must pass before committing
- Use `npm run test:watch` during development
- Test setup file: `src/__tests__/setup.ts`
- Coverage configuration in `vitest.config.ts` (excludes src-tauri, test files, main.tsx)
- Update test mocks when adding new store properties

### State Structure (Key Parts)
```typescript
interface AppState {
  cache: {
    imageViewStates: Map<string, ImageViewState>; // Per-image zoom/pan state
    preloaded: Map<string, ImageData>;
    thumbnails: Map<string, string>;
  };
  view: {
    zoom: number; // 10-2000
    panX: number;
    panY: number;
    isFullscreen: boolean;
    isMaximized: boolean;
  };
  // ... other state
}
```

### Common Development Tasks

#### Adding New Store Actions
1. Add action to `AppActions` interface
2. Implement in store with immutable updates
3. Update test mocks in `src/utils/testUtils.tsx`
4. Add unit tests in `src/store/__tests__/index.test.ts`

#### Working with Image Navigation
- Current image state is saved automatically before navigation
- Navigation restores saved view state or uses defaults
- Folder changes clear all view states

#### Debugging
- Frontend: Use React DevTools and browser console
- Backend: Use `console.log!` in Rust (shows in `cargo test -- --nocapture`)
- State: Zustand devtools available in development

### Code Style
- Use TypeScript strict mode
- Follow existing patterns for component structure
- Use `useCallback` for event handlers in components
- Prefer functional components with hooks

For detailed project specifications, see [PROJECT_SPEC.md](./PROJECT_SPEC.md).