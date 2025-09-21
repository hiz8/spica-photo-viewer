# Data Model: Spica Photo Viewer

**Date**: 2025-09-21
**Phase**: 1 - Design
**Status**: Complete

## Core Entities

### ImageFile

Represents a displayable image file with metadata and loading state.

```typescript
interface ImageFile {
  id: string;              // Unique identifier (file path hash)
  path: string;            // Absolute file path
  filename: string;        // Display name without path
  extension: string;       // File extension (.jpg, .png, etc.)
  size: number;           // File size in bytes
  dimensions?: {          // Image dimensions (loaded asynchronously)
    width: number;
    height: number;
  };
  lastModified: Date;     // File modification timestamp
  format: ImageFormat;    // Detected image format
  loadingState: LoadingState;
  error?: string;         // Error message if loading failed
}

enum ImageFormat {
  JPEG = 'jpeg',
  PNG = 'png',
  WEBP = 'webp',
  GIF = 'gif',
  UNKNOWN = 'unknown'
}

enum LoadingState {
  PENDING = 'pending',
  LOADING = 'loading',
  LOADED = 'loaded',
  ERROR = 'error'
}
```

**Validation Rules**:
- `path` must be absolute and exist on file system
- `filename` must not be empty
- `extension` must be supported format
- `size` must be positive number
- `lastModified` must be valid date

**State Transitions**:
- PENDING → LOADING (when load starts)
- LOADING → LOADED (successful load)
- LOADING → ERROR (failed load)
- ERROR → LOADING (retry)

### ThumbnailCache

Cached thumbnail data with expiration and storage metadata.

```typescript
interface ThumbnailCache {
  id: string;              // Image file ID reference
  thumbnailPath: string;   // Cache file path (%APPDATA%/SpicaPhotoViewer/cache/)
  base64Data?: string;     // In-memory base64 data (optional)
  size: ThumbnailSize;     // Thumbnail dimensions
  generatedAt: Date;       // Creation timestamp
  expiresAt: Date;         // Expiration timestamp (24 hours)
  fileHash: string;        // Original file hash for validation
  cacheState: CacheState;
}

interface ThumbnailSize {
  width: number;           // Always 30 for main thumbnails
  height: number;          // Always 30 for main thumbnails
}

enum CacheState {
  GENERATING = 'generating',
  CACHED = 'cached',
  EXPIRED = 'expired',
  FAILED = 'failed'
}
```

**Validation Rules**:
- `thumbnailPath` must be valid cache directory path
- `size.width` and `size.height` must be 30 (current requirement)
- `expiresAt` must be 24 hours from `generatedAt`
- `fileHash` must match source file

### FolderContext

Collection of all supported image files in the current directory.

```typescript
interface FolderContext {
  id: string;              // Folder path hash
  path: string;            // Absolute folder path
  imageFiles: ImageFile[]; // All supported images in folder
  sortOrder: SortOrder;    // Current sort method
  currentIndex: number;    // Index of currently viewed image
  totalCount: number;      // Total number of images
  loadingProgress: number; // 0-100 percentage of files scanned
}

enum SortOrder {
  NAME_ASC = 'name_asc',
  NAME_DESC = 'name_desc',
  DATE_ASC = 'date_asc',
  DATE_DESC = 'date_desc',
  SIZE_ASC = 'size_asc',
  SIZE_DESC = 'size_desc'
}
```

**Validation Rules**:
- `path` must be valid directory
- `currentIndex` must be within bounds [0, totalCount-1]
- `imageFiles` must be sorted according to `sortOrder`
- `totalCount` must equal `imageFiles.length`
- `loadingProgress` must be 0-100

### ViewState

Current zoom, pan, and display state of the image viewer.

```typescript
interface ViewState {
  zoom: number;            // Current zoom level (10-2000)
  panX: number;           // Pan offset X in pixels
  panY: number;           // Pan offset Y in pixels
  isFullscreen: boolean;   // Fullscreen mode state
  thumbnailOpacity: number; // 0.5 or 1.0 based on hover
  fitToWindow: boolean;    // Auto-fit mode enabled
  zoomOrigin: Point;      // Last zoom center point
}

interface Point {
  x: number;              // X coordinate
  y: number;              // Y coordinate
}
```

**Validation Rules**:
- `zoom` must be between 10 and 2000
- `panX` and `panY` can be any number (negative for left/up pan)
- `thumbnailOpacity` must be exactly 0.5 or 1.0
- `zoomOrigin` coordinates must be within viewport bounds

### PreloadCache

Memory cache for preloaded full-resolution images.

```typescript
interface PreloadCache {
  entries: Map<string, PreloadEntry>; // Image ID -> cached data
  maxSize: number;        // Maximum entries (40)
  currentSize: number;    // Current number of entries
  lruOrder: string[];     // LRU tracking (image IDs)
}

interface PreloadEntry {
  imageId: string;        // Reference to ImageFile.id
  imageData: string;      // Base64 image data
  loadedAt: Date;         // Load timestamp
  accessedAt: Date;       // Last access timestamp
  sizeBytes: number;      // Memory usage estimate
}
```

**Validation Rules**:
- `maxSize` is fixed at 40 (constitutional requirement)
- `currentSize` must not exceed `maxSize`
- `lruOrder` must contain exactly `currentSize` unique IDs
- Total memory estimate should not exceed constitutional limits

### ApplicationState

Root state container for the entire application.

```typescript
interface ApplicationState {
  currentImage: {
    file: ImageFile | null;
    index: number;
    data: string | null;   // Base64 image data
    error: string | null;
  };

  folder: FolderContext | null;
  view: ViewState;
  cache: {
    thumbnails: Map<string, ThumbnailCache>;
    preloaded: PreloadCache;
  };

  ui: {
    isLoading: boolean;
    showAbout: boolean;
    error: string | null;
    keyboardShortcuts: boolean;
  };

  settings: {
    cacheDirectory: string;
    maxCacheSize: number;   // MB
    thumbnailQuality: number; // 1-100
    preloadDistance: number;  // ±N images
  };
}
```

**Validation Rules**:
- `currentImage.index` must be valid for current folder
- `folder` can be null only on startup
- `cache.thumbnails` size should not exceed reasonable limits
- `settings.maxCacheSize` should not exceed constitutional memory limits

## Entity Relationships

```
FolderContext 1:N ImageFile
ImageFile 1:1 ThumbnailCache (optional)
ImageFile 1:1 PreloadEntry (optional)
ApplicationState 1:1 FolderContext
ApplicationState 1:1 ViewState
ApplicationState 1:1 PreloadCache
```

## State Transitions

### Image Loading Flow

1. **Folder Scan**: FolderContext created → ImageFiles added (PENDING state)
2. **Current Image Load**: Selected ImageFile → LOADING → LOADED/ERROR
3. **Thumbnail Generation**: ImageFile → ThumbnailCache (GENERATING → CACHED/FAILED)
4. **Preload**: Background ImageFiles → PreloadEntry → LRU management

### Navigation Flow

1. **User Navigation**: Update currentImage.index
2. **Check Preload**: If cached, immediate display
3. **Load New**: If not cached, start loading + show loading state
4. **Update Cache**: Add to preload cache, evict LRU if needed
5. **Generate Thumbnail**: Background thumbnail creation if missing

### Error Recovery Flow

1. **Image Load Error**: Set error state, display error icon
2. **Thumbnail Error**: Use fallback error thumbnail
3. **Cache Error**: Fallback to memory-only operation
4. **Navigation**: Skip errored files, maintain valid index

## Performance Considerations

### Memory Management

- **Preload Cache**: Maximum 40 entries (~200-400MB typical)
- **Thumbnail Cache**: Disk-based with memory index
- **LRU Eviction**: Automatic cleanup of old entries
- **Garbage Collection**: WeakMap usage where appropriate

### Async Operations

- **File Scanning**: Non-blocking folder enumeration
- **Image Loading**: Background loading with progress indicators
- **Thumbnail Generation**: Worker pool with queue management
- **Cache Cleanup**: Scheduled background maintenance

### Validation Performance

- **Path Validation**: Minimal file system calls
- **Format Detection**: Header-based detection before full decode
- **Bounds Checking**: Arithmetic validation without external calls
- **State Consistency**: Efficient state reconciliation

This data model provides a robust foundation for the Spica Photo Viewer while maintaining performance requirements and error handling standards defined in the constitution.