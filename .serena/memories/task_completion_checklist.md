# Task Completion Checklist

## When a coding task is completed, run these commands:

### 1. TypeScript Compilation Check
```bash
tsc
```
Ensures no TypeScript errors before proceeding.

### 2. Frontend Tests
```bash
npm test
```
Runs all React/TypeScript unit tests to ensure no regressions.

### 3. Backend Tests (if Rust code was modified)
```bash
cd src-tauri
cargo test --lib
```
Runs Rust unit tests for backend functionality.

### 4. Build Verification
```bash
npm run build
```
Verifies the entire build process works:
- Syncs version between package.json and Cargo.toml
- Compiles TypeScript
- Builds frontend with Vite

### 5. Optional: Coverage Report
```bash
npm run test:coverage
```
Generate test coverage report to ensure adequate test coverage.

## Pre-commit Verification
Before committing changes, verify:
- [ ] All tests pass (`npm test` and `cargo test --lib`)
- [ ] TypeScript compiles without errors (`tsc`)
- [ ] Build succeeds (`npm run build`)
- [ ] No linting errors (if applicable)

## Development Mode Testing
For quick verification during development:
```bash
npm run tauri dev
```
Starts both frontend and backend in development mode to verify functionality.

## Notes
- No explicit linting commands found in package.json
- TypeScript strict mode catches most style issues
- Comprehensive test suite prevents regressions
- Build process includes version synchronization automatically