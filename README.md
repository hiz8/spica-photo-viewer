# Spica Photo Viewer

A lightweight, fast image viewer application for Windows, inspired by Picasa Photo Viewer. Built with Tauri and React, it provides a seamless image browsing experience with thumbnail navigation and smooth zoom/pan capabilities.

## Features

- **Supported Formats**: JPEG, PNG, WebP, GIF (with animation)
- **Thumbnail Navigation**: Horizontal thumbnail strip with smooth scrolling
- **Zoom & Pan**: Mouse wheel zoom with cursor positioning, drag-to-pan
- **Keyboard Shortcuts**: Full keyboard navigation support
- **Fullscreen Mode**: F11 toggle for immersive viewing
- **File Association**: Double-click image files to open directly
- **Windows Integration**: MSI installer with file type associations

## Installation

### For Users

1. Download the latest MSI installer from [Releases](https://github.com/hiz8/spica-photo-viewer/releasess)
2. Run the installer and follow the setup wizard
3. Double-click any supported image file to open with Spica Photo Viewer

### Supported File Types

- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)
- GIF (.gif) - with animation support

## Usage

### Keyboard Shortcuts

- `←/→` - Navigate previous/next image
- `↑/↓` - Zoom in/out
- `Ctrl+0` - Reset zoom to 100%
- `Ctrl+Shift+O` - Open with... (Windows "Open with" dialog)
- `F11` - Toggle fullscreen mode
- `F1` - Show about dialog
- `ESC` - Exit fullscreen/about dialog, or close application

### Mouse Controls

- **Mouse Wheel** - Zoom in/out at cursor position
- **Drag** - Pan image when zoomed
- **Double-click** - Reset zoom to fit window
- **Thumbnail Click** - Jump to specific image
- **Thumbnail Scroll** - Navigate through images

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v20.19+ or v22.12+)
- [Rust](https://rust-lang.org/)
- [Tauri Prerequisites](https://tauri.app/)

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd spica-photo-viewer

# Install dependencies
npm install

# Start development server
npm run tauri dev
```

### Testing

The project includes comprehensive unit tests for both frontend and backend code:

```bash
# Run frontend tests (React/TypeScript)
npm test

# Run frontend tests in watch mode
npm run test:watch

# Run frontend tests with coverage
npm run test:coverage

# Run backend tests (Rust)
cd src-tauri
cargo test --lib

# Run specific test modules
cargo test commands::file::tests
cargo test utils::image::tests
cargo test commands::cache::tests
```

### Linting and Formatting

The project uses [Biome](https://biomejs.dev/) for linting and formatting frontend code (TypeScript/React):

```bash
# Check for lint issues
npm run lint

# Fix lint issues automatically
npm run lint:fix

# Check code formatting
npm run format

# Fix formatting issues automatically
npm run format:fix
```

### Building

```bash
# Build for production
npm run tauri build
```

The MSI installer will be generated in `src-tauri/target/release/bundle/msi/`.

### Version Management

The project uses a centralized version management system:

```bash
# Sync current version from package.json to all config files
npm run sync-version

# Update version in package.json, then sync manually if needed
npm version patch|minor|major
npm run sync-version
```

**Version Files:**

- `package.json` - Master source of truth
- `src-tauri/tauri.conf.json` - Auto-synced from package.json
- `src-tauri/Cargo.toml` - Auto-synced from package.json
- `src/components/AboutDialog.tsx` - Displays version dynamically via Tauri API

**Note:** The build process automatically syncs versions, so you only need to update `package.json`.

### Project Structure

```
spica-photo-viewer/
├── src/                    # Frontend source (React + TypeScript)
│   ├── components/         # React components
│   ├── hooks/              # Custom React hooks
│   ├── store/              # Zustand state management
│   └── types/              # TypeScript type definitions
├── src-tauri/              # Backend source (Rust)
│   ├── src/
│   │   ├── commands/       # Tauri command handlers
│   │   └── utils/          # Utility functions
│   └── tauri.conf.json     # Tauri configuration
└── CLAUDE.md               # Detailed project specifications
```

## Tech Stack

- **Frontend**: React 19 + TypeScript + Zustand
- **Backend**: Tauri v2.1 + Rust
- **Build Tools**: Vite + Tauri CLI
- **Installer**: WiX Toolset (MSI)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Known Issues

- Large images (2000px+) may have slower load times due to base64 encoding

## License

[MIT License](LICENSE) - see the LICENSE file for details.

## Acknowledgments

- Inspired by Picasa Photo Viewer
- Built with [Tauri](https://tauri.app/) and [React](https://reactjs.org/)
- Thanks to the open-source community for the amazing tools and libraries

## Support

For bug reports and feature requests, please [open an issue](https://github.com/hiz8/spica-photo-viewer/issues).
