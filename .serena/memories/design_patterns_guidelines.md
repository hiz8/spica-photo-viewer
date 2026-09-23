# Design Patterns and Guidelines

## Core Design Principles

### Architecture Pattern
- **Tauri Application**: Rust backend + React frontend with IPC communication
- **State Management**: Zustand store with typed actions and state
- **Component Design**: Functional React components with custom hooks
- **Error Handling**: Graceful degradation, never crash the application

### Frontend Patterns

#### Custom Hooks Pattern
- `useImagePreloader`: Handles image loading and caching logic
- `useKeyboard`: Centralizes keyboard shortcut handling
- `useCacheManager`: Manages thumbnail cache operations
- `useFileDrop`: Handles drag & drop functionality

#### State Management (Zustand)
```typescript
interface AppState {
  currentImage: { path: string; index: number; data: ImageData | null; error: Error | null };
  folder: { path: string; images: ImageInfo[]; sortOrder: "name" | "date" };
  view: { zoom: number; panX: number; panY: number; isFullscreen: boolean };
  cache: { thumbnails: Map<string, string>; preloaded: Map<string, ImageData> };
  ui: { isLoading: boolean; showAbout: boolean; isDragOver: boolean; error: Error | null };
}
```

### Backend Patterns

#### Tauri Command Pattern
- Commands in `src-tauri/src/commands/` modules
- Return `Result<T, String>` for error handling
- Async operations for I/O operations
- Clear separation: `file.rs` for file ops, `cache.rs` for caching

#### Error Handling Strategy
- **Corrupted files**: Display error icon, allow navigation to continue
- **Missing files**: Remove from thumbnail bar, auto-navigate to next
- **Drag & drop errors**: Show brief notifications, don't crash

### Performance Patterns

#### Image Loading Strategy
1. Display current image immediately
2. Generate thumbnails for ±10 images from current
3. Preload ±20 images at full resolution
4. Use circular buffer for memory efficiency

#### Caching Strategy
- **Location**: `%APPDATA%/SpicaPhotoViewer/cache/`
- **Naming**: `{hash}_{size}.jpg`
- **Retention**: 24 hours, clean on startup
- **Memory**: LRU cache for decoded images

### UI/UX Patterns

#### Thumbnail Bar Auto-Hide
- Hidden (opacity 0) by default; shows on hover or a quick downward flick, hides again after a timeout or an upward flick — Picasa-style, see `PROJECT_SPEC.md` §Thumbnail Bar
- Image info overlay: shown and hidden together with the thumbnail bar

#### Navigation Patterns
- Keyboard: Arrow keys for navigation and zoom
- Mouse: Wheel for zoom at cursor position, drag for pan
- Thumbnails: Click to jump, scroll to navigate

### Testing Patterns
- **Specification-based testing**: Prevent regressions during development
- **Test factories**: Reusable test data creation (`testFactories.ts`)
- **Isolated testing**: Tempfile for Rust tests, jsdom for React tests
- **Comprehensive coverage**: Both unit and integration testing

### File Association Pattern
- MSI installer with Windows file type registration
- Double-click opens images directly in fullscreen mode
- Graceful handling when opened standalone vs. via file association