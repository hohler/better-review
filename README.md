# Better Review

Guided pull request reviews for Bitbucket, as a macOS app (Tauri).

## Requirements

- `twg` CLI, logged in to the Bitbucket workspaces you review in
- One AI agent CLI, logged in. Guide and tour are generated on your own account:
  - `claude` (Claude Code): Sonnet for the guide, Opus for the tour, or
  - `copilot` (GitHub Copilot CLI): Copilot picks the model your plan allows. Each guide or tour is one premium request.
- To build: Node, Rust (`brew install rustup && rustup default stable`), Xcode command line tools

On first start a short wizard asks which agent to use and for your Bitbucket workspace. You can change the agent later under Better Review > Settings (Cmd+,).

## Build

```bash
npm install
npm run build   # src-tauri/target/release/bundle/macos/Better Review.app
npm run dev     # live development
npm test        # diff parser and guide checks
```

## How it works

- `src-tauri/src/main.rs`: runs `twg` and the AI agent (`claude` or `copilot`, both with all tools disabled), caches diffs, guides and tours per commit in `~/Library/Caches/better-review`
- `ui/lib.js`: diff parser, generated/test file detection, guide normalization
- `ui/app.js`: the interface. Settings, workspaces and "Reviewed" marks live in the webview's localStorage.

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
