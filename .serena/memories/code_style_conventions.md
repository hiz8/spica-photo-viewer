# Code Style and Conventions

## TypeScript/React Conventions

### Configuration
- **TypeScript**: Strict mode enabled with ES2020 target
- **React**: v19 with JSX transform, functional components
- **Module Resolution**: Bundler mode with ESNext modules

### TypeScript Rules (from tsconfig.json)
- `strict: true` - All strict type checking enabled
- `noUnusedLocals: true` - No unused variables
- `noUnusedParameters: true` - No unused function parameters  
- `noFallthroughCasesInSwitch: true` - Switch cases must break

### React Patterns
- **Components**: Functional components with hooks
- **State Management**: Zustand store pattern
- **Props**: TypeScript interfaces for all props
- **Testing**: React Testing Library + Vitest

### File Organization
```
src/
├── components/           # React components
├── hooks/               # Custom React hooks  
├── store/               # Zustand store
├── types/               # TypeScript type definitions
├── utils/               # Utility functions
└── __tests__/           # Test setup files
```

## Rust Conventions

### Crate Structure
- **Library**: `spica_photo_viewer_lib` (to avoid Windows naming conflicts)
- **Modules**: `commands/` and `utils/` separation
- **Tests**: Comprehensive unit tests with tempfile for isolation

### Naming
- **Commands**: Snake_case (e.g., `get_folder_images`)
- **Modules**: Snake_case files, clear separation of concerns
- **Error Handling**: Result<T, String> pattern for Tauri commands

### Dependencies
- Standard Rust 2021 edition
- Serde for serialization
- Image crate for processing
- Tauri framework patterns

## Testing Conventions
- **Frontend**: Vitest with jsdom environment
- **Backend**: Cargo test with tempfile for file operations
- **Coverage**: V8 provider, excludes test files and build artifacts
- **Test Files**: `__tests__/` directories and `.test.ts` suffixes