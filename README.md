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

## Opening the unsigned app

The release build is not signed or notarized by Apple, so macOS blocks it the first time. You only have to allow it once.

1. Unzip the download and move `Better Review.app` to your Applications folder.
2. Double-click the app. macOS shows a warning that it cannot verify the app. Click **Done** (not "Move to Trash").
3. Open **System Settings** and go to **Privacy & Security**.
4. Scroll down to the **Security** section. You will see: "Better Review" was blocked to protect your Mac.
5. Click **Open Anyway** next to it. The button only appears for about an hour after step 2, so repeat step 2 if it is missing.
6. Confirm with Touch ID or your password, then click **Open Anyway** in the dialog that follows.

From then on the app opens normally.

### Alternative: Terminal

If you prefer, or if macOS says the app "is damaged and can't be opened", remove the download quarantine flag instead:

```bash
xattr -dr com.apple.quarantine "/Applications/Better Review.app"
```

On a managed Mac your organization may disable "Open Anyway". In that case build the app locally (see Build), which needs no approval.
