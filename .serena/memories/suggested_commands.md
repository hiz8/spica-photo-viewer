# Suggested Commands

## Development Commands

### Frontend Development
```bash
npm run dev           # Start development server with Vite
npm run build         # Build for production (syncs version + TypeScript + Vite build)
npm run preview       # Preview production build
```

### Tauri Development
```bash
npm run tauri dev     # Start Tauri development mode (both frontend + backend)
npm run tauri build   # Build Tauri application with installer
```

### Testing Commands
```bash
npm test              # Run all tests once (vitest --run)
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

### Backend Testing (Rust)
```bash
cd src-tauri
cargo test --lib      # Run Rust unit tests
cargo test -- --nocapture  # Run tests with output
```

### Utility Commands
```bash
npm run sync-version  # Sync version between package.json and Cargo.toml
```

## Windows System Commands
Since this is Windows development:
- `dir` instead of `ls`
- `type` instead of `cat`
- `findstr` instead of `grep`
- `cd` works the same
- PowerShell commands available

## Build Process
1. `npm run sync-version` - Sync versions
2. `tsc` - TypeScript compilation
3. `vite build` - Frontend build
4. Tauri handles Rust compilation and MSI creation