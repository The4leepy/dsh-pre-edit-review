/**
 * Phase 1.5 spike S2 — "editable diff" feasibility probe.
 *
 * Goal: prove that a `vscode.diff` whose RIGHT side is a text document backed by
 * a custom `FileSystemProvider` (scheme `dpr`) is editable, and that saving it
 * delivers the final (user-edited) bytes back through the provider's `writeFile`.
 *
 * The self-test is triggered by the command `dpr.runS2SelfTest` and also runs
 * automatically ~1500 ms after activation when a workspace folder is open.
 * It always writes `.spike/s2-report.json` under the first workspace folder.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

const SCHEME = 'dpr';
const PROPOSAL_PATH = '/s2/proposal.txt';
const PROPOSAL_URI = vscode.Uri.parse(`${SCHEME}:${PROPOSAL_PATH}`);
const ORIGINAL_CONTENT = 'line1\nline2\nline3\n';
const PROPOSAL_SEED = 'line1\nline2 changed\nline3\n';
const EDIT_MARKER = 'S2-USER-EDIT';
const DIFF_TITLE = 'S2 Editable Diff';
const SPIKE_DIR = '.spike';
const ORIGINAL_FILE = 's2-original.txt';
const REPORT_FILE = 's2-report.json';

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

interface WriteState {
  calls: number;
  lastUri: string | null;
  lastContent: string | null;
}

interface SelfTestReport {
  ok: boolean;
  startedAt: string;
  vscodeVersion: string;
  steps: Step[];
  providerWriteFileCalled: boolean;
  providerWriteFileContent: string | null;
  error: string | null;
}

interface TabSnapshot {
  groupActive: boolean;
  tabs: Array<{
    label: string;
    isActive: boolean;
    isDirty: boolean;
    input: unknown;
  }>;
}

/**
 * In-memory `FileSystemProvider` for the `dpr:` scheme.
 *
 * NOTE: `registerFileSystemProvider` is called WITHOUT `isReadonly` on purpose —
 * the whole point of the spike is to see whether VS Code treats the document as
 * editable. See `ensureProvider()`.
 */
class DprFileSystemProvider implements vscode.FileSystemProvider {
  private readonly files = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private writeState: WriteState = { calls: 0, lastUri: null, lastContent: null };
  private mtime = Date.now();

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changeEmitter.event;

  getWriteState(): WriteState {
    return {
      calls: this.writeState.calls,
      lastUri: this.writeState.lastUri,
      lastContent: this.writeState.lastContent,
    };
  }

  reset(entries: Record<string, string>): void {
    this.files.clear();
    for (const [filePath, content] of Object.entries(entries)) {
      this.files.set(filePath, content);
    }
    this.writeState = { calls: 0, lastUri: null, lastContent: null };
    this.mtime = Date.now();
  }

  watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    return { dispose: (): void => undefined };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const key = this.key(uri);
    const text = this.files.get(key);
    if (text !== undefined) {
      return {
        type: vscode.FileType.File,
        ctime: this.mtime,
        mtime: this.mtime,
        size: Buffer.byteLength(text, 'utf8'),
      };
    }
    if (this.isDirectory(key)) {
      return { type: vscode.FileType.Directory, ctime: this.mtime, mtime: this.mtime, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const base = this.key(uri);
    const prefix = base === '/' ? '/' : `${base}/`;
    const entries: [string, vscode.FileType][] = [];
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const remainder = filePath.slice(prefix.length);
      if (remainder.length === 0) {
        continue;
      }
      const slash = remainder.indexOf('/');
      const name = slash === -1 ? remainder : remainder.slice(0, slash);
      const type = slash === -1 ? vscode.FileType.File : vscode.FileType.Directory;
      if (!entries.some(([existingName]) => existingName === name)) {
        entries.push([name, type]);
      }
    }
    return entries;
  }

  createDirectory(_uri: vscode.Uri): void {
    // The spike only needs files; directories are implied by file paths.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const text = this.files.get(this.key(uri));
    if (text === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return Buffer.from(text, 'utf8');
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): void {
    // Deliberately permissive: the spike must observe the bytes VS Code sends on
    // save, so accept whatever create/overwrite flags the save path supplies.
    const key = this.key(uri);
    const text = Buffer.from(content).toString('utf8');
    this.files.set(key, text);
    this.mtime = Date.now();
    this.writeState = { calls: this.writeState.calls + 1, lastUri: uri.toString(), lastContent: text };
    // No change event is fired here on purpose: a changed-event during the save
    // round-trip can make VS Code reload the document it is writing.
    console.log(
      `[dpr] provider.writeFile uri=${uri.toString()} bytes=${content.byteLength} create=${options.create} overwrite=${options.overwrite}`,
    );
  }

  delete(uri: vscode.Uri, _options: { readonly recursive: boolean }): void {
    const key = this.key(uri);
    if (this.files.delete(key)) {
      this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      return;
    }
    const prefix = key === '/' ? '/' : `${key}/`;
    for (const filePath of Array.from(this.files.keys())) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    }
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): void {
    const oldKey = this.key(oldUri);
    const newKey = this.key(newUri);
    const text = this.files.get(oldKey);
    if (text === undefined) {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }
    if (this.files.has(newKey) && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(newUri);
    }
    this.files.delete(oldKey);
    this.files.set(newKey, text);
    this.mtime = Date.now();
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: newUri }]);
  }

  private key(uri: vscode.Uri): string {
    return uri.path.length === 0 ? '/' : uri.path;
  }

  private isDirectory(key: string): boolean {
    if (key === '/') {
      return true;
    }
    const prefix = `${key}/`;
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}

let provider: DprFileSystemProvider | undefined;
let providerRegistration: vscode.Disposable | undefined;
let inFlightRun: Promise<SelfTestReport> | undefined;

function ensureProvider(): DprFileSystemProvider {
  if (provider) {
    return provider;
  }
  const created = new DprFileSystemProvider();
  created.reset({ [PROPOSAL_PATH]: PROPOSAL_SEED });
  provider = created;
  // Deliberately no `isReadonly` here: the document must be presented as writable.
  providerRegistration = vscode.workspace.registerFileSystemProvider(SCHEME, created, {
    isCaseSensitive: true,
  });
  return created;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function firstSpikeDir(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return null;
  }
  return path.join(folder.uri.fsPath, SPIKE_DIR);
}

function findProposalDocument(): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === SCHEME && document.uri.path === PROPOSAL_PATH,
  );
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(intervalMs);
  }
}

function describeTabInput(input: unknown): unknown {
  if (input instanceof vscode.TabInputTextDiff) {
    return {
      kind: 'diff',
      original: input.original.toString(),
      modified: input.modified.toString(),
    };
  }
  if (input instanceof vscode.TabInputText) {
    return { kind: 'text', uri: input.uri.toString() };
  }
  return { kind: typeof input };
}

function isDprDiffTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  return input instanceof vscode.TabInputTextDiff && sameUri(input.modified, PROPOSAL_URI);
}

function snapshotTabs(): TabSnapshot[] {
  return vscode.window.tabGroups.all.map((group) => ({
    groupActive: group.isActive,
    tabs: group.tabs.map((tab) => ({
      label: tab.label,
      isActive: tab.isActive,
      isDirty: tab.isDirty,
      input: describeTabInput(tab.input),
    })),
  }));
}

async function runSelfTest(trigger: 'auto' | 'command'): Promise<SelfTestReport> {
  const startedAt = new Date().toISOString();
  const steps: Step[] = [];
  const report: SelfTestReport = {
    ok: false,
    startedAt,
    vscodeVersion: vscode.version,
    steps,
    providerWriteFileCalled: false,
    providerWriteFileContent: null,
    error: null,
  };
  const addStep = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
  };

  let spikeDir: string | null = null;
  let applyEditAccepted = false;
  let writeFileProved = false;
  let saveResult = false;

  try {
    addStep('trigger', true, trigger === 'auto' ? 'auto-run ~1500 ms after activation' : 'command dpr.runS2SelfTest');

    spikeDir = firstSpikeDir();
    if (spikeDir === null) {
      throw new Error('No workspace folder is open; cannot create .spike/ or write the report.');
    }
    await fs.mkdir(spikeDir, { recursive: true });

    const originalPath = path.join(spikeDir, ORIGINAL_FILE);
    await fs.writeFile(originalPath, ORIGINAL_CONTENT, 'utf8');
    addStep(
      'create-original',
      true,
      `wrote ${ORIGINAL_CONTENT.length} chars to ${originalPath} (${JSON.stringify(ORIGINAL_CONTENT)})`,
    );

    const fileSystemProvider = ensureProvider();
    fileSystemProvider.reset({ [PROPOSAL_PATH]: PROPOSAL_SEED });
    addStep(
      'register-fs-provider',
      true,
      `scheme=${SCHEME}; options.isReadonly omitted; seeded ${PROPOSAL_URI.toString()} with ${PROPOSAL_SEED.length} chars (${JSON.stringify(PROPOSAL_SEED)})`,
    );

    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(originalPath), PROPOSAL_URI, DIFF_TITLE, {
      preview: false,
    });
    addStep(
      'open-diff',
      true,
      `vscode.diff(${originalPath}, ${PROPOSAL_URI.toString()}, "${DIFF_TITLE}", {preview:false})`,
    );

    const document = await waitFor(findProposalDocument, 5000);
    if (document === undefined) {
      const openUris = vscode.workspace.textDocuments.map((openDocument) => openDocument.uri.toString());
      throw new Error(
        `The dpr proposal TextDocument did not appear within 5 s. Open documents: ${JSON.stringify(openUris)}`,
      );
    }
    await delay(300); // let the diff editor render and register its tab

    const visibleInEditors = vscode.window.visibleTextEditors.some((editor) =>
      sameUri(editor.document.uri, PROPOSAL_URI),
    );
    addStep(
      'document-found',
      true,
      `uri=${document.uri.toString()}; inVisibleTextEditors=${visibleInEditors}; isDirty=${document.isDirty}`,
    );

    addStep('document-scheme', document.uri.scheme === SCHEME, `uri.scheme=${document.uri.scheme} (expected ${SCHEME})`);

    const readOnlyProbe = (document as unknown as { readonly isReadOnly?: boolean }).isReadOnly;
    addStep(
      'document-readonly',
      readOnlyProbe !== true,
      readOnlyProbe === undefined
        ? 'isReadOnly is not present on the public TextDocument API (probe => undefined); editability is proven by applyEdit below'
        : `document.isReadOnly=${String(readOnlyProbe)}`,
    );

    const initialText = document.getText();
    addStep(
      'document-content',
      true,
      `getText().length=${initialText.length}; text=${JSON.stringify(initialText)}`,
    );

    const writable = vscode.workspace.fs.isWritableFileSystem(SCHEME);
    addStep(
      'writable-file-system',
      writable === true,
      `vscode.workspace.fs.isWritableFileSystem('${SCHEME}') => ${String(writable)}`,
    );

    // Programmatic equivalent of typing: a WorkspaceEdit is rejected by VS Code
    // exactly when the target document is read-only (same path as keyboard input).
    const beforeEditLength = document.getText().length;
    const insertPosition = document.positionAt(beforeEditLength);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, insertPosition, EDIT_MARKER);
    applyEditAccepted = await vscode.workspace.applyEdit(edit);
    addStep(
      'apply-edit',
      applyEditAccepted,
      `insert "${EDIT_MARKER}" at offset ${beforeEditLength}; vscode.workspace.applyEdit returned ${applyEditAccepted}`,
    );

    const textAfterEdit = document.getText();
    const editVisible =
      textAfterEdit.length === beforeEditLength + EDIT_MARKER.length && textAfterEdit.endsWith(EDIT_MARKER);
    addStep(
      'edit-visible-in-document',
      editVisible,
      `getText().length=${textAfterEdit.length} (expected ${beforeEditLength + EDIT_MARKER.length}); endsWithMarker=${textAfterEdit.endsWith(EDIT_MARKER)}; isDirty=${document.isDirty}`,
    );

    const activeEditor = vscode.window.activeTextEditor;
    addStep(
      'active-editor',
      true,
      activeEditor
        ? `activeTextEditor.document.uri=${activeEditor.document.uri.toString()}`
        : 'activeTextEditor=undefined (diff editors are not exposed as TextEditor)',
    );

    const tabSnapshot = snapshotTabs();
    const diffTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => isDprDiffTab(tab));
    addStep(
      'diff-tab',
      diffTabs.length > 0,
      `dpr diff tab count=${diffTabs.length}; labels=${JSON.stringify(diffTabs.map((tab) => tab.label))}; allTabs=${JSON.stringify(tabSnapshot)}`,
    );

    // Trigger the real save path. If the provider is asked to write, VS Code took
    // the document's writability seriously.
    saveResult = await document.save();
    await delay(100); // let the provider write settle before reading the log
    addStep(
      'document-save',
      saveResult === true,
      `document.save() returned ${saveResult}; isDirty after save=${document.isDirty}`,
    );

    const writeState = fileSystemProvider.getWriteState();
    writeFileProved =
      writeState.calls > 0 &&
      writeState.lastContent !== null &&
      writeState.lastContent.endsWith(EDIT_MARKER);
    addStep(
      'provider-writeFile',
      writeFileProved,
      `calls=${writeState.calls}; lastUri=${String(writeState.lastUri)}; receivedLength=${
        writeState.lastContent === null ? 'null' : writeState.lastContent.length
      }; equalsDocumentText=${writeState.lastContent === textAfterEdit}; receivedContent=${JSON.stringify(
        writeState.lastContent,
      )}`,
    );

    const readBack = Buffer.from(await vscode.workspace.fs.readFile(PROPOSAL_URI)).toString('utf8');
    addStep(
      'read-back',
      readBack === textAfterEdit,
      `workspace.fs.readFile(${PROPOSAL_URI.toString()}) length=${readBack.length}; equalsEditedDocument=${readBack === textAfterEdit}`,
    );

    const originalOnDisk = await fs.readFile(originalPath, 'utf8');
    addStep(
      'original-untouched',
      originalOnDisk === ORIGINAL_CONTENT,
      `left-side file still contains ${JSON.stringify(originalOnDisk)} (${originalOnDisk.length} chars)`,
    );
  } catch (error) {
    report.error = describeError(error);
    addStep('exception', false, report.error);
  } finally {
    if (provider) {
      const writeState = provider.getWriteState();
      report.providerWriteFileCalled = writeState.calls > 0;
      report.providerWriteFileContent = writeState.lastContent;
    } else {
      report.providerWriteFileCalled = false;
      report.providerWriteFileContent = null;
    }

    report.ok = report.error === null && applyEditAccepted && writeFileProved;

    let reportPath: string | null = null;
    try {
      if (spikeDir === null) {
        console.error(`[dpr] S2 self-test could not write ${SPIKE_DIR}/${REPORT_FILE} (no workspace folder).`);
      } else {
        reportPath = path.join(spikeDir, REPORT_FILE);
        await fs.mkdir(spikeDir, { recursive: true });
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      }
    } catch (writeError) {
      report.error = report.error ?? describeError(writeError);
      console.error(`[dpr] S2 self-test failed to write report: ${describeError(writeError)}`);
    }

    console.log(
      `[dpr] S2 self-test ${report.ok ? 'PASSED' : 'FAILED'} trigger=${trigger} vscode=${vscode.version} applyEdit=${applyEditAccepted} save=${saveResult} providerWriteFileCalled=${report.providerWriteFileCalled} report=${reportPath ?? 'NOT_WRITTEN'}`,
    );
  }

  return report;
}

function runOnce(trigger: 'auto' | 'command'): Promise<SelfTestReport> {
  if (!inFlightRun) {
    inFlightRun = runSelfTest(trigger).finally(() => {
      inFlightRun = undefined;
    });
  }
  return inFlightRun;
}

export function activate(context: vscode.ExtensionContext): void {
  ensureProvider();

  if (providerRegistration) {
    context.subscriptions.push(providerRegistration);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('dpr.runS2SelfTest', () => runOnce('command')),
  );

  const spikeDir = firstSpikeDir();
  if (spikeDir === null) {
    console.log('[dpr] S2 self-test auto-run skipped: no workspace folder open.');
    return;
  }

  // `.spike/` is created if missing; the self-test then runs ~1500 ms after activation.
  void fs
    .mkdir(spikeDir, { recursive: true })
    .then(() => {
      const timer = setTimeout(() => {
        void runOnce('auto').catch((error: unknown) => {
          console.error(`[dpr] S2 self-test auto-run crashed: ${describeError(error)}`);
        });
      }, 1500);
      context.subscriptions.push({
        dispose: (): void => clearTimeout(timer),
      });
      console.log(`[dpr] S2 self-test scheduled in ~1500 ms (spike dir: ${spikeDir})`);
    })
    .catch((error: unknown) => {
      console.error(`[dpr] S2 self-test auto-run setup failed: ${describeError(error)}`);
    });
}

export function deactivate(): void {
  providerRegistration?.dispose();
  providerRegistration = undefined;
  provider = undefined;
}
