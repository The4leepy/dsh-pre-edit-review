# DeepSeek Pre-edit Review — VS Code extension (S2 spike)

Phase 1.5 spike S2: opens the command `DPR: Run S2 self-test`, which writes `.spike/s2-original.txt`, opens a `vscode.diff` against the custom `dpr:/s2/proposal.txt` document, edits the right side with a `WorkspaceEdit`, saves it, and records what the `dpr` `FileSystemProvider.writeFile` received in `.spike/s2-report.json`. It also runs ~1500 ms after activation and never writes the left-hand original file.

Build: `node build.mjs`; package: `pnpm exec vsce package --no-dependencies --allow-missing-repository`.

Install the VSIX: `code --install-extension deepseek-pre-edit-review-0.1.0.vsix`, then run "Developer: Reload Window" and "DPR: Run S2 self-test" from the Command Palette.
