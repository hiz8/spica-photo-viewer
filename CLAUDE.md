# CLAUDE.md - Spica Photo Viewer

## Project Overview

**Spica Photo Viewer** is a lightweight, fast image viewer application for Windows, inspired by Picasa Photo Viewer. Built with Tauri (Rust backend) and React (TypeScript frontend), it provides a seamless image browsing experience with thumbnail navigation and smooth zoom/pan capabilities.

## Core Requirements

### Supported Platforms

- Windows 10/11 (primary target)
- MSI installer with file association for image formats

### Supported Image Formats

- **Required**: JPEG, PNG, WebP
- **Optional**: GIF (with auto-play animation support)

### Key Features

1. **Image Display**: Central image viewer with automatic fit-to-window
2. **Thumbnail Bar**: Horizontal thumbnail strip at bottom (30×30px)
3. **Navigation**: Keyboard and mouse controls for browsing
4. **Zoom & Pan**: Smooth zoom (10%-2000%) with drag-to-pan capability
5. **Fullscreen Mode**: F11 toggle for immersive viewing
6. **File Association**: Double-click image files to open directly
7. **Drag & Drop**: Drop image files onto the window to open them

## Technical Architecture

### Technology Stack

- **Backend**: Tauri v2 (Rust)
  - File system operations
  - Image processing and caching
  - Window management
  - OS integration (file association)
- **Frontend**: React + TypeScript
  - UI components and interactions
  - Image rendering and transformations
  - Keyboard/mouse event handling
  - State management (Redux/Zustand recommended)

- **Build Tools**:
  - Vite for frontend bundling
  - Tauri CLI for building and packaging
  - WiX Toolset for MSI installer creation

### Project Structure

```
spica-photo-viewer/
├── src/                      # Frontend source
│   ├── components/
│   │   ├── ImageViewer.tsx   # Main image display component
│   │   ├── ThumbnailBar.tsx  # Thumbnail navigation bar
│   │   ├── DropZone.tsx      # Drag & drop overlay component
│   │   ├── ErrorDisplay.tsx  # Error state component
│   │   └── AboutDialog.tsx   # App info dialog
│   ├── hooks/
│   │   ├── useImageLoader.ts # Image loading and caching
│   │   ├── useKeyboard.ts    # Keyboard shortcuts
│   │   ├── useZoomPan.ts     # Zoom and pan logic
│   │   └── useDragDrop.ts    # Drag & drop handling
│   ├── services/
│   │   ├── imageService.ts   # Image processing utilities
│   │   └── cacheService.ts   # Thumbnail cache management
│   ├── types/
│   │   └── index.ts          # TypeScript type definitions
│   ├── App.tsx               # Main app component
│   └── main.tsx              # Entry point
├── src-tauri/                # Backend source
│   ├── src/
│   │   ├── main.rs           # Tauri main entry
│   │   ├── commands/         # Tauri command handlers
│   │   │   ├── file.rs       # File operations
│   │   │   ├── image.rs      # Image processing
│   │   │   └── cache.rs      # Cache management
│   │   └── utils/
│   │       └── image.rs      # Image utilities
│   ├── Cargo.toml            # Rust dependencies
│   └── tauri.conf.json       # Tauri configuration
├── package.json              # Node dependencies
├── tsconfig.json             # TypeScript config
└── vite.config.ts           # Vite config
```

## Detailed Specifications

### User Interface

#### Layout

- **Main Window**:
  - Default: Fullscreen when opened via file
  - Minimal size when opened standalone
  - No minimum size restrictions

- **Image Display Area** (90% of window):
  - Centered image with automatic fit-to-window
  - Black background
  - Maintains aspect ratio

- **Thumbnail Bar** (10% of window, bottom):
  - Height: ~40px (30px thumbnails + padding)
  - 50% opacity when not hovered (mouse not over image or thumbnails)
  - 100% opacity on hover
  - Current image always centered
  - Empty space for first/last images to maintain center position

- **Image Info Overlay** (top of thumbnail bar):
  - Format: `{filename} ({width} × {height})`
  - Small, unobtrusive font
  - Same opacity behavior as thumbnail bar

- **Drag & Drop Overlay** (when no image is loaded):
  - Visible only in standalone startup mode
  - Dashed border with "Drop image here" message
  - Semi-transparent overlay effect on drag-over

### Controls

#### Keyboard Shortcuts

- **←/→**: Navigate previous/next image
- **↑/↓**: Zoom in/out (center-based)
- **Ctrl+0**: Reset zoom to 100%
- **F11**: Toggle fullscreen
- **ESC**: Exit application

#### Mouse Controls

- **Thumbnail click**: Jump to image
- **Mouse wheel on thumbnails**: Navigate images
- **Mouse wheel on image**: Zoom (cursor-based)
- **Drag on zoomed image**: Pan
- **Double-click image**: Reset zoom/fit to window
- **Drag & Drop image file**: Open dropped image and switch to its folder

### Image Loading Strategy

#### Display Image

1. Load and display requested image immediately
2. Decode at display resolution for performance
3. Keep original in memory for zoom operations

#### Thumbnail Generation

1. Start with current image thumbnail
2. Generate thumbnails for ±10 images from current
3. Progressively load remaining thumbnails
4. Priority order: current → nearby → distant

#### Preloading

- Preload ±20 images (40 total max) at full resolution
- Use circular buffer for memory efficiency
- Load priority: next likely navigation direction

#### Caching

- **Location**: `%APPDATA%/SpicaPhotoViewer/cache/`
- **Thumbnail naming**: `{hash}_{size}.jpg`
- **Retention**: 24 hours (clean on startup)
- **Fallback**: Memory-only if file system fails

### Error Handling

#### Corrupted/Unsupported Files

- Display error icon in main viewer
- Show error thumbnail (generic error image)
- Allow navigation to skip over
- Log error details for debugging

#### Missing Files

- Handle gracefully if files are deleted while viewing
- Remove from thumbnail bar
- Auto-navigate to next available image

#### Drag & Drop Errors

- **Folder drop**: Show brief toast notification "Please drop image files only"
- **Non-image files**: Ignore silently
- **Multiple files**: Process first valid image, ignore others
- **No valid images**: Show brief error message

### Performance Optimization

#### Memory Management

- Max memory usage: ~500MB
- Release images outside preload range
- Use WebP for thumbnail cache (smaller size)
- Implement LRU cache for decoded images

#### Rendering

- Use CSS transforms for zoom/pan (GPU accelerated)
- Virtual scrolling for thumbnail bar if >100 images
- Debounce rapid navigation (max 30fps)
- Progressive JPEG loading for large images

## Implementation Phases

### Phase 1: Core Viewer (MVP)

- [ ] Basic Tauri (v2) + React (v19) setup
- [ ] Single image display
- [ ] Folder scanning and image listing
- [ ] Previous/next navigation (keyboard)
- [ ] Basic zoom (center-based)
- [ ] Drag & drop support (basic file handling)

### Phase 2: Thumbnail System

- [ ] Thumbnail generation
- [ ] Thumbnail bar UI
- [ ] Thumbnail navigation
- [ ] Current image centering
- [ ] Opacity hover effects

### Phase 3: Advanced Features

- [ ] Mouse-based zoom (cursor position)
- [ ] Pan functionality
- [ ] Image preloading
- [ ] Thumbnail caching
- [ ] Error handling

### Phase 4: Polish & Optimization

- [ ] Fullscreen mode
- [ ] File association
- [ ] MSI installer
- [ ] GIF animation support
- [ ] Performance optimization
- [ ] About dialog

## Tauri Commands (IPC)

```rust
// File operations
#[tauri::command]
async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String>

#[tauri::command]
async fn load_image(path: String) -> Result<ImageData, String>

#[tauri::command]
async fn handle_dropped_file(path: String) -> Result<ImageInfo, String>

// Thumbnail operations
#[tauri::command]
async fn generate_thumbnail(path: String) -> Result<String, String>

#[tauri::command]
async fn get_cached_thumbnail(path: String) -> Result<Option<String>, String>

// Cache management
#[tauri::command]
async fn clear_old_cache() -> Result<(), String>

// System operations
#[tauri::command]
fn get_initial_file() -> Option<String>  // For file association

#[tauri::command]
fn validate_image_file(path: String) -> Result<bool, String>

#[tauri::command]
fn show_about_dialog() -> Result<(), String>
```

## State Management Structure

```typescript
interface AppState {
  // Current viewing state
  currentImage: {
    path: string;
    index: number;
    data: ImageData | null;
    error: Error | null;
  };

  // Folder state
  folder: {
    path: string;
    images: ImageInfo[];
    sortOrder: "name" | "date";
  };

  // View state
  view: {
    zoom: number; // 10-2000
    panX: number; // Pan offset X
    panY: number; // Pan offset Y
    isFullscreen: boolean;
    thumbnailOpacity: number; // 0.5 or 1.0
  };

  // Cache state
  cache: {
    thumbnails: Map<string, string>; // path -> base64
    preloaded: Map<string, ImageData>; // path -> data
  };

  // UI state
  ui: {
    isLoading: boolean;
    showAbout: boolean;
    isDragOver: boolean; // For drag & drop feedback
    error: Error | null;
  };
}
```

## Testing Strategy

### Unit Tests

- Image format detection
- Cache expiration logic
- Zoom calculations
- Navigation bounds checking

### Integration Tests

- File system operations
- IPC command handling
- Thumbnail generation
- Cache persistence

### E2E Tests

- Full navigation flow
- Zoom and pan interactions
- Keyboard shortcuts
- File association launch

## Build & Deployment

### Development

```bash
npm install
npm run tauri dev
```

### Production Build

```bash
npm run tauri build
```

### Installer Creation

- Use Tauri's WiX integration
- Configure file associations for .jpg, .jpeg, .png, .webp, .gif
- Set registry entries for default image viewer

## Performance Targets

- **Startup time**: <500ms to first image display
- **Image switch**: <100ms for preloaded images
- **Thumbnail generation**: <50ms per thumbnail
- **Memory usage**: <500MB for typical usage
- **Smooth zoom/pan**: 60fps minimum

## Future Enhancements (Post-MVP)

- [ ] Multi-selection and batch operations
- [ ] Basic image editing (rotate, crop)
- [ ] Slideshow mode
- [ ] EXIF data viewer
- [ ] RAW format support
- [ ] Network share support
- [ ] Portable version (no install)
- [ ] Theme customization
- [ ] Plugin system

## Development Guidelines

1. **Code Style**: Use Prettier and ESLint for consistency
2. **Commits**: Conventional commits for clear history
3. **Documentation**: JSDoc for public APIs
4. **Error Handling**: Never crash, always graceful degradation
5. **Accessibility**: Keyboard navigation for all features
6. **Localization**: Prepare for i18n from the start (use keys, not hardcoded strings)

## Resources & References

- [Tauri Documentation](https://tauri.app/)
- [React + TypeScript Best Practices](https://react-typescript-cheatsheet.netlify.app/)
- [Image Processing in Rust](https://github.com/image-rs/image)
- [Picasa Photo Viewer UI Reference](https://www.google.com/photos/about/)

---

## Notes for AI Coding Assistant

When implementing this project:

1. **Start with Phase 1** - Get the basic viewer working first
2. **Use modern React patterns** - Hooks, functional components, proper TypeScript
3. **Keep Rust code minimal** - Only what can't be done in frontend
4. **Optimize later** - Get it working, then make it fast
5. **Test file associations early** - This can be tricky on Windows
6. **Handle edge cases** - Empty folders, single image, corrupt files, drag & drop errors
7. **Implement drag & drop early** - Test with various file types and multiple files
8. **Use native OS dialogs** - For file operations when needed
9. **Keep UI responsive** - Use async/await, don't block the main thread

The goal is a fast, lightweight, reliable image viewer that "just works" when users double-click an image file.
