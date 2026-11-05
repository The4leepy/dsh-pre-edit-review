# DeepSeek Pre-edit Review — VS Code extension

The VS Code client of **DeepSeek Pre-edit Review**. It connects to the DSH Host
plugin over a Unix domain socket, opens one editable `vscode.diff` per proposed
file change, and only sends a `decision` back to the Host after the user clicks
**Accept** (or types the accept keybinding). The Host is the only component that
writes to the workspace; the extension never commits anything itself.

## How it works

- The right side of the diff is a `dpr:` document backed by an in-memory
  `FileSystemProvider` registered **without** `isReadonly`, so it is editable.
- `dpr.accept` sends the document text (`document.getText()`, including unsaved
  edits) as `finalContent`, then saves the document (clears the dirty state so
  closing the diff never shows a save prompt) and closes the tab.
- `dpr.reject` asks for an optional reason, reverts the proposal document, closes
  the tab, and sends a `reject` decision.
- New files are shown against an empty `dpr:` original, so the left side always
  renders even though the file does not exist yet.
- Connection: `hello` with the token from `<stateDir>/token`; automatic 3 s
  backoff reconnect; one warning when the connection goes offline.
- `dpr.acceptAll` (only with `dpr.autoAccept` enabled) arms a 5-minute
  auto-accept window and shows an `AUTO-ACCEPT` status bar item.

## Commands

| Command | Description |
|---|---|
| `dpr.accept` | Accept the active/first pending review (`ctrl+alt+enter` on a `dpr:` editor). |
| `dpr.reject` | Reject the active/first pending review (`ctrl+alt+backspace` on a `dpr:` editor). |
| `dpr.showPending` | Quick pick of pending reviews; opens/focuses its diff. |
| `dpr.reconnect` | Reconnect to the Host immediately. |
| `dpr.acceptAll` | Arm/disarm the auto-accept window (requires `dpr.autoAccept`). |
| `dpr.runSelfTest` | Run the in-process mock-Host self-test and write `.spike/ext-selftest.json`. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `dpr.stateDir` | `~/.dsh/pre-edit-review` | Must match the Host plugin's state directory (socket + token). |
| `dpr.autoConnect` | `true` | Connect automatically on activation. |
| `dpr.autoAccept` | `false` | Permit `dpr.acceptAll` to arm auto-accept. |

## Self-test

`dpr.runSelfTest` starts a **mock Host** on a temporary Unix socket, writes a
real token file, connects the real IPC client/`ReviewSession`, and runs two
scenarios:

1. **accept-with-edit** — the mock sends `review/request`; the test applies a
   `WorkspaceEdit` to the proposed document and calls `dpr.accept`; the mock
   asserts the decision's `finalContent` contains the edit marker.
2. **reject (new file)** — the mock sends a request for a non-existent file (the
   left side is the empty `dpr:` original); the test calls `dpr.reject` and the
   mock asserts `status === 'reject'` and that no workspace file was created.

A JSON report `{ok, vscodeVersion, steps, error?}` is written to
`<workspace>/.spike/ext-selftest.json`. The test also runs automatically ~2 s
after activation when `<workspace>/.spike` exists.

## Build

```sh
node build.mjs
../../node_modules/.bin/vsce package --no-dependencies --allow-missing-repository
```

Install the produced VSIX with `code --install-extension deepseek-pre-edit-review-0.1.0.vsix`.
