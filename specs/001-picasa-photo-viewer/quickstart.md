# Quickstart: Spica Photo Viewer

**Date**: 2025-09-21
**Phase**: 1 - Design
**Purpose**: Rapid development setup and validation testing

## Development Setup (5 minutes)

### Prerequisites Installation

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node.js 18+ (if not already installed)
# Download from https://nodejs.org/ or use package manager

# Install Tauri CLI
cargo install tauri-cli

# Verify installations
rustc --version    # Should be 1.75+
node --version     # Should be 18+
npm --version      # Should be 9+
cargo --version    # Should be 1.75+
```

### Project Initialization

```bash
# Clone and setup project
cd C:\Users\hirof\Project\hiz\spica-photo-viewer

# Install frontend dependencies
npm install

# Install Rust dependencies (first build)
npm run tauri build --debug

# Start development server
npm run tauri dev
```

**Expected Result**: Application window opens showing default Tauri + React interface

## Phase 1 Validation (MVP Core)

### Test Case 1: Basic Application Launch

```bash
# Start development server
npm run tauri dev
```

**Success Criteria**:
- [ ] Application window opens within 2 seconds
- [ ] No console errors in terminal
- [ ] React UI renders with main container
- [ ] Window is resizable and responsive

### Test Case 2: Folder Image Scanning

```typescript
// Test in browser dev tools console (F12)
await window.__TAURI__.invoke('get_folder_images', {
  folder_path: 'C:\\Users\\Public\\Pictures\\Sample Pictures',
  sort_order: 'name_asc'
});
```

**Success Criteria**:
- [ ] Returns array of supported image files
- [ ] Each file has required metadata (path, size, format)
- [ ] Files are sorted by name ascending
- [ ] Unsupported files are filtered out

### Test Case 3: Image Loading

```typescript
// Test loading a sample image
await window.__TAURI__.invoke('load_image', {
  image_path: 'C:\\Users\\Public\\Pictures\\Sample Pictures\\sample.jpg'
});
```

**Success Criteria**:
- [ ] Returns base64 image data
- [ ] Includes width and height metadata
- [ ] Format is correctly detected
- [ ] Loading completes within 500ms

### Test Case 4: Thumbnail Generation

```typescript
// Test thumbnail creation
await window.__TAURI__.invoke('generate_thumbnail', {
  image_path: 'C:\\Users\\Public\\Pictures\\Sample Pictures\\sample.jpg',
  size: 30
});
```

**Success Criteria**:
- [ ] Generates 30x30 pixel thumbnail
- [ ] Returns base64 thumbnail data
- [ ] Creates cache file in %APPDATA%/SpicaPhotoViewer/cache/
- [ ] Generation completes within 50ms

## Phase 2 Validation (UI Components)

### Test Case 5: Image Viewer Component

```bash
# Navigate to image viewer page
# Should display centered image with black background
```

**Success Criteria**:
- [ ] Image displays centered in viewport
- [ ] Black background fills entire area
- [ ] Image maintains aspect ratio
- [ ] Auto-fits to window size

### Test Case 6: Thumbnail Bar

```bash
# Load folder with multiple images
# Verify thumbnail bar appears at bottom
```

**Success Criteria**:
- [ ] Thumbnail bar shows at bottom (10% of window height)
- [ ] Displays 30x30 pixel thumbnails
- [ ] Current image is centered in bar
- [ ] Opacity changes on hover (50% → 100%)

### Test Case 7: Navigation

```bash
# Test keyboard navigation
# Press ← and → arrow keys
```

**Success Criteria**:
- [ ] Left arrow navigates to previous image
- [ ] Right arrow navigates to next image
- [ ] Navigation is smooth (<100ms)
- [ ] Current thumbnail updates in bar

## Phase 3 Validation (Advanced Features)

### Test Case 8: Zoom and Pan

```bash
# Test zoom functionality
# Scroll mouse wheel over image
# Drag image when zoomed
```

**Success Criteria**:
- [ ] Mouse wheel zooms in/out
- [ ] Zoom centers on cursor position
- [ ] Drag pans zoomed image
- [ ] Smooth 60fps animations

### Test Case 9: Keyboard Shortcuts

```bash
# Test all keyboard shortcuts
# ↑↓ zoom, Ctrl+0 reset, F11 fullscreen, ESC exit
```

**Success Criteria**:
- [ ] Up arrow zooms in
- [ ] Down arrow zooms out
- [ ] Ctrl+0 resets to fit-to-window
- [ ] F11 toggles fullscreen
- [ ] ESC exits application

### Test Case 10: Cache Management

```typescript
// Test cache operations
await window.__TAURI__.invoke('get_cache_stats');
await window.__TAURI__.invoke('clear_old_cache', { max_age: 1 });
```

**Success Criteria**:
- [ ] Cache stats return accurate data
- [ ] Old cache entries are deleted
- [ ] Cache directory is created if missing
- [ ] Memory-only fallback works if cache fails

## Phase 4 Validation (Integration)

### Test Case 11: File Association

```bash
# Double-click an image file in Windows Explorer
# Should launch Spica Photo Viewer
```

**Success Criteria**:
- [ ] Application launches from file double-click
- [ ] Specified image loads immediately
- [ ] Opens in fullscreen mode
- [ ] Folder context is established

### Test Case 12: Performance Validation

```bash
# Load folder with 100+ images
# Navigate rapidly between images
# Monitor memory usage in Task Manager
```

**Success Criteria**:
- [ ] Memory usage stays below 500MB
- [ ] Navigation maintains <100ms response
- [ ] No memory leaks during extended use
- [ ] Smooth 60fps during zoom/pan

### Test Case 13: Error Handling

```bash
# Test with corrupted image files
# Test with missing files
# Test with unsupported formats
```

**Success Criteria**:
- [ ] Displays error icon for corrupted files
- [ ] Shows error thumbnail in bar
- [ ] Continues navigation past errors
- [ ] Never crashes or freezes

## Common Issues & Solutions

### Build Errors

**Issue**: Rust compilation fails
**Solution**:
```bash
rustup update
cargo clean
npm run tauri build --debug
```

**Issue**: Node dependencies fail
**Solution**:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Runtime Errors

**Issue**: Image loading fails
**Solution**: Check file permissions and supported formats

**Issue**: Cache directory not writable
**Solution**: Application should fallback to memory-only mode

**Issue**: Thumbnail generation slow
**Solution**: Check image file sizes and system resources

## Development Workflow

### Hot Reload Development

```bash
# Start dev server (hot reload enabled)
npm run tauri dev

# Make changes to React components in src/
# Changes auto-reload in application window

# Make changes to Rust code in src-tauri/
# Requires restart of dev server
```

### Testing Changes

```bash
# Run frontend tests
npm test

# Run Rust tests
cd src-tauri && cargo test

# Integration tests
npm run test:integration
```

### Building for Production

```bash
# Debug build (faster, larger)
npm run tauri build --debug

# Release build (optimized)
npm run tauri build

# MSI installer (Windows)
npm run tauri build -- --bundles msi
```

## Success Metrics

By the end of each phase, all test cases should pass with these metrics:

- **Startup Time**: <500ms from launch to first image
- **Navigation Speed**: <100ms between preloaded images
- **Thumbnail Generation**: <50ms per 30x30 thumbnail
- **Memory Usage**: <500MB during normal operation
- **Frame Rate**: 60fps during zoom and pan operations
- **Cache Efficiency**: >90% cache hit rate for thumbnails
- **Error Recovery**: 100% graceful handling of file errors

This quickstart guide ensures rapid iteration and validation throughout the development process while maintaining constitutional performance and reliability standards.