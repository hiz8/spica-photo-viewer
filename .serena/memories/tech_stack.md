# Tech Stack

## Frontend
- **Framework**: React 19 with TypeScript
- **State Management**: Zustand
- **Build Tool**: Vite
- **Testing**: Vitest with @testing-library/react
- **Styling**: CSS (App.css)

## Backend
- **Framework**: Tauri v2.1 (Rust)
- **Image Processing**: image crate (v0.25)
- **File Operations**: walkdir crate
- **Encoding**: base64 crate
- **JSON**: serde + serde_json

## Development Tools
- **TypeScript**: v5.8.3 with strict mode
- **Test Environment**: jsdom with vitest
- **Coverage**: v8 provider
- **Build**: Node.js scripts + Tauri CLI

## Key Dependencies
### Frontend
- @tauri-apps/api: Tauri frontend bindings
- @tauri-apps/plugin-dialog: File dialogs
- @tauri-apps/plugin-opener: File operations
- zustand: State management

### Backend  
- tauri: Main framework
- image: Image processing and format support
- walkdir: Directory traversal
- base64: Image encoding for frontend transfer