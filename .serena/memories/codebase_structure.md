# Codebase Structure

## Root Level
```
spica-photo-viewer/
├── src/                 # Frontend React/TypeScript code
├── src-tauri/          # Backend Rust/Tauri code  
├── public/             # Static assets
├── scripts/            # Build scripts (sync-version.cjs)
├── dist/               # Build output
├── package.json        # Node.js dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── vitest.config.ts    # Test configuration
├── vite.config.ts      # Vite build configuration
├── CLAUDE.md           # Project specifications and guidelines
└── README.md           # User documentation
```

## Frontend Structure (src/)
```
src/
├── components/
│   ├── ImageViewer.tsx      # Main image display component
│   ├── ThumbnailBar.tsx     # Thumbnail navigation bar
│   ├── AboutDialog.tsx      # App info dialog
│   ├── DropZone.tsx         # Drag & drop overlay
│   ├── FileOpenButton.tsx   # File selection button
│   └── __tests__/           # Component tests
├── hooks/
│   ├── useImagePreloader.ts # Image loading and caching
│   ├── useKeyboard.ts       # Keyboard shortcuts
│   ├── useCacheManager.ts   # Thumbnail cache management
│   ├── useFileDrop.ts       # Drag & drop handling
│   └── __tests__/           # Hook tests
├── store/
│   ├── index.ts             # Zustand state management
│   └── __tests__/           # Store tests
├── types/
│   └── index.ts             # TypeScript type definitions
├── utils/
│   ├── testFactories.ts     # Test data factories
│   └── testUtils.tsx        # Test utilities
├── App.tsx                  # Main app component
└── main.tsx                 # Entry point
```

## Backend Structure (src-tauri/)
```
src-tauri/
├── src/
│   ├── commands/
│   │   ├── file.rs          # File operations (load, scan folders)
│   │   ├── cache.rs         # Cache management
│   │   └── mod.rs           # Module exports
│   ├── utils/
│   │   ├── image.rs         # Image processing utilities
│   │   └── mod.rs           # Module exports
│   ├── lib.rs               # Main library entry with Tauri setup
│   ├── main.rs              # Executable entry point
│   └── test_utils.rs        # Test helper functions
├── Cargo.toml               # Rust dependencies
├── tauri.conf.json          # Tauri application configuration
└── build.rs                 # Build script
```

## Key Architecture Patterns
- **Frontend**: React functional components with custom hooks
- **State**: Zustand for global state management
- **Backend**: Tauri commands for IPC between frontend/backend
- **Testing**: Comprehensive unit tests for both frontend and backend
- **Build**: Vite for frontend, Cargo for backend, Tauri CLI for packaging