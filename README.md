# Better Review

Guided pull request reviews for Bitbucket, as a macOS app (Tauri).

## Requirements

- `twg` CLI, logged in to the Bitbucket workspaces you review in
- `claude` CLI (Claude Code), logged in. The review guide is generated with `claude -p` on your own account.
- To build: Node, Rust (`brew install rustup && rustup default stable`), Xcode command line tools

## Build

```bash
npm install
npm run build   # src-tauri/target/release/bundle/macos/Better Review.app
npm run dev     # live development
npm test        # diff parser and guide checks
```

## How it works

- `src-tauri/src/main.rs`: runs `twg` and `claude`, caches diffs and guides per commit in `~/Library/Caches/better-review`
- `ui/lib.js`: diff parser, generated/test file detection, guide normalization
- `ui/app.js`: the interface. Workspaces and "Reviewed" marks live in the webview's localStorage.

The app is unsigned. On another Mac, build it there or allow it once in System Settings.
