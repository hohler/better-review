# Better Review

Guided pull request reviews for Bitbucket, as a desktop app for macOS and Windows (Tauri).

## Requirements

- `twg` CLI, logged in to the Bitbucket workspaces you review in
- One AI agent CLI, logged in. Guide and tour are generated on your own account:
  - `claude` (Claude Code): by default Sonnet for the guide, Opus for the tour, or
  - `copilot` (GitHub Copilot CLI): by default Copilot picks the model your plan allows. Each guide or tour is one premium request.
- To build: Node, Rust (`brew install rustup && rustup default stable`), Xcode command line tools

On first start a short wizard asks which agent to use and for your Bitbucket workspace. You can change the agent, and the model for guide and tour, later under Better Review > Settings (Cmd+,).

## Build

```bash
npm install
npm run build   # src-tauri/target/release/bundle/macos/Better Review.app
npm run dev     # live development
npm test        # diff parser and guide checks
```

## How it works

- `src-tauri/src/main.rs`: runs `twg` and the AI agent (`claude` or `copilot`, both with all tools disabled), caches diffs, guides and tours per commit in `~/Library/Caches/better-review` (Windows: `%LOCALAPPDATA%\better-review\cache`)
- `ui/lib.js`: diff parser, generated/test file detection, guide normalization
- `ui/app.js`: the interface. Settings, workspaces and "Reviewed" marks live in the webview's localStorage.

## Windows

The installer (`Better Review_<version>_x64-setup.exe`) is built on GitHub by the "Windows build" workflow. It is attached to each release, and a manual run of the workflow gives a test build as a download.

- Install `twg` and `claude` or `copilot` as on macOS. For Claude Code use the native installer (`claude.exe`): the npm version is a `.cmd` shim, which may not accept the long arguments the app passes.
- The installer is not signed, so SmartScreen warns on first start: click **More info**, then **Run anyway**.
- To build locally on Windows: `npm ci`, then `npx tauri build`.

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
