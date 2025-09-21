# Research Phase: Spica Photo Viewer

**Date**: 2025-09-21
**Phase**: 0 - Research and Technology Selection
**Status**: Complete

## Overview

Research completed for Spica Photo Viewer implementation using Tauri + React architecture. All technical decisions are based on performance requirements, Windows platform targets, and constitutional principles defined in the project.

## Technology Decisions

### Core Architecture

**Decision**: Tauri 1.5+ with React 18+ frontend
**Rationale**:
- Tauri provides native performance with web technologies
- Rust backend ensures memory safety and performance for image processing
- React frontend enables rapid UI development with modern patterns
- Built-in Windows integration for file associations and MSI packaging
- Smaller bundle size compared to Electron (critical for lightweight requirement)

**Alternatives considered**:
- Electron: Rejected due to memory overhead (conflicts with <500MB constraint)
- Pure Rust (egui/iced): Rejected due to UI development complexity
- .NET/WPF: Rejected due to preference for cross-platform potential

### Image Processing

**Decision**: image-rs crate with tokio async runtime
**Rationale**:
- Mature Rust image processing library with JPEG, PNG, WebP, GIF support
- Zero-copy operations where possible for performance
- Thread-safe operations for thumbnail generation
- Built-in format detection and validation

**Alternatives considered**:
- WebAssembly image libraries: Rejected due to performance overhead
- Native Windows APIs: Rejected due to complexity and cross-platform goals

### Frontend State Management

**Decision**: React Context + useReducer for complex state, useState for simple state
**Rationale**:
- Avoiding external dependencies (Redux/Zustand) for lighter bundle
- Built-in React patterns sufficient for single-user desktop app
- Easier debugging and simpler mental model
- Faster development without additional learning curve

**Alternatives considered**:
- Redux Toolkit: Rejected due to complexity overhead for simple state needs
- Zustand: Considered but unnecessary for this scope

### Caching Strategy

**Decision**: WebP format for thumbnail cache with LRU memory management
**Rationale**:
- WebP provides 25-35% smaller file sizes than JPEG for thumbnails
- Native support in modern browsers (React frontend compatibility)
- Fast encoding/decoding performance
- LRU ensures memory bounds compliance

**Alternatives considered**:
- AVIF: Rejected due to limited browser support
- JPEG: Rejected due to larger file sizes
- Binary caching: Rejected due to implementation complexity

### Build and Packaging

**Decision**: Vite for frontend bundling, Tauri CLI for packaging, WiX for MSI
**Rationale**:
- Vite provides fastest dev server and optimized production builds
- Tauri CLI handles cross-compilation and native packaging
- WiX is industry standard for Windows MSI creation
- Integrated file association setup through Tauri configuration

**Alternatives considered**:
- Webpack: Rejected due to slower build times
- NSIS installer: Rejected in favor of MSI standard on Windows
- Manual packaging: Rejected due to complexity

## Performance Research

### Memory Management Patterns

**Research findings**:
- Circular buffer for preloaded images (±20 images = 40 total max)
- WeakMap for image cache to enable garbage collection
- Virtual scrolling for thumbnail bar when >100 images
- Progressive loading for large images (>10MB)

### Zoom/Pan Implementation

**Research findings**:
- CSS transforms with `will-change: transform` for GPU acceleration
- `transform-origin` manipulation for cursor-based zoom
- `requestAnimationFrame` for smooth 60fps animations
- Debounced input handling to prevent performance issues

### File System Optimization

**Research findings**:
- Windows `ReadDirectoryChangesW` API through Tauri for folder watching
- Async file scanning with `tokio::fs` for non-blocking operations
- File extension filtering at OS level for performance
- Batch thumbnail generation with worker pool

## Integration Research

### Tauri IPC Patterns

**Best practices identified**:
- Minimal command surface area (8-10 commands max)
- Async commands for all file operations
- Structured error types with user-friendly messages
- Event system for file system changes

### Windows Integration

**Implementation approach**:
- Registry entries for file associations (.jpg, .jpeg, .png, .webp, .gif)
- Shell integration for "Open with" context menu
- Windows-native error dialogs through Tauri
- AppData cache directory with proper permissions

## Risk Mitigation

### Performance Risks

**Risk**: Large image files causing memory overflow
**Mitigation**: Progressive loading, image downsampling for display, strict memory limits

**Risk**: Slow thumbnail generation blocking UI
**Mitigation**: Background generation with tokio spawn, progress indicators, fallback thumbnails

### Compatibility Risks

**Risk**: Unsupported image formats causing crashes
**Mitigation**: Format validation before processing, graceful error handling, error thumbnails

**Risk**: Cache corruption or permission issues
**Mitigation**: Memory-only fallback, cache validation on startup, graceful degradation

## Development Setup Research

### Development Environment

**Required tools**:
- Rust 1.75+ with cargo
- Node.js 18+ with npm
- Tauri CLI (`cargo install tauri-cli`)
- Windows 10 SDK (for MSI packaging)

**Development workflow**:
- `npm run tauri dev` for development server
- `npm run tauri build` for production builds
- Hot reload for React components
- Rust rebuild only when backend changes

## Conclusion

All technical research complete with no remaining unknowns. Architecture decisions align with constitutional requirements for performance, error handling, and user experience. Ready to proceed with Phase 1 design activities.

**Next Phase**: Data model design and API contracts generation