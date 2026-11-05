// packages/dsh-plugin/src/config.ts
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
var DEFAULT_REVIEW_TOOLS = ["write", "edit", "str_replace_editor"];
var DEFAULT_MUTATION_PATTERNS = [
  "(^|_)(write|edit|create|delete|remove|move|rename|replace|patch|apply)(_|$)"
];
var DEFAULT_STATE_DIR = "~/.dsh/pre-edit-review";
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}
function fail(message) {
  throw new Error(`dsh-pre-edit-review config: ${message}`);
}
function positiveInt(value, name2, fallback, min = 1) {
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    fail(`${name2} must be an integer >= ${min}`);
  }
  return value;
}
function stringArray(value, name2, fallback) {
  if (value === void 0) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(`${name2} must be an array of non-empty strings`);
  }
  return value;
}
function normalizeConfig(raw) {
  const input = raw ?? {};
  if (typeof input !== "object" || input === null) fail("config must be an object");
  const mode = input.mode ?? "review";
  if (mode !== "review" && mode !== "off") fail('mode must be "review" or "off"');
  const unknownToolPolicy = input.unknownToolPolicy ?? "deny";
  if (unknownToolPolicy !== "deny" && unknownToolPolicy !== "pass") fail('unknownToolPolicy must be "deny" or "pass"');
  const fallback = input.fallback ?? "deny";
  if (fallback !== "deny" && fallback !== "dsh-approval") fail('fallback must be "deny" or "dsh-approval"');
  const stateDir = expandHome(input.stateDir ?? DEFAULT_STATE_DIR);
  const socketPath = input.socketPath !== void 0 ? expandHome(input.socketPath) : resolve(stateDir, "ipc.sock");
  return {
    enabled: input.enabled ?? true,
    mode,
    reviewTools: stringArray(input.reviewTools, "reviewTools", DEFAULT_REVIEW_TOOLS),
    exemptTools: stringArray(input.exemptTools, "exemptTools", []),
    unknownToolPolicy,
    mutationNamePatterns: stringArray(input.mutationNamePatterns, "mutationNamePatterns", DEFAULT_MUTATION_PATTERNS).map(
      (pattern) => new RegExp(pattern, "i")
    ),
    approvalTimeoutMs: positiveInt(input.approvalTimeoutMs, "approvalTimeoutMs", 6e5, 1e3),
    maxFileBytes: positiveInt(input.maxFileBytes, "maxFileBytes", 2 * 1024 * 1024, 1),
    fallback,
    enableAutoAccept: input.enableAutoAccept ?? true,
    autoAcceptMax: positiveInt(input.autoAcceptMax, "autoAcceptMax", 20, 1),
    stateDir,
    socketPath,
    clientConnectTimeoutMs: positiveInt(input.clientConnectTimeoutMs, "clientConnectTimeoutMs", 3e3, 100),
    noticeOnUserEdit: input.noticeOnUserEdit ?? true,
    allowPause: input.allowPause ?? input.allowBypass ?? true,
    auditRetentionDays: positiveInt(input.auditRetentionDays, "auditRetentionDays", 30, 1)
  };
}

// packages/dsh-plugin/src/classifier.ts
function presentsDiff(definition, args) {
  if (definition?.presentCall === void 0) return false;
  try {
    const view = definition.presentCall(args);
    return view?.card === "diff";
  } catch {
    return true;
  }
}
function classify(input) {
  const { toolName, args, definition, config, hasBuilder } = input;
  if (config.enabled !== true || config.mode === "off") return { action: "pass" };
  if (config.exemptTools.includes(toolName)) return { action: "pass" };
  if (config.reviewTools.includes(toolName)) {
    return hasBuilder(toolName) ? { action: "review", toolName } : {
      action: "deny",
      toolName,
      reason: `tool "${toolName}" is configured for pre-edit review but no proposal builder exists`
    };
  }
  if (presentsDiff(definition, args)) {
    return hasBuilder(toolName) ? { action: "review", toolName } : {
      action: "deny",
      toolName,
      reason: `tool "${toolName}" presents a file diff but has no proposal builder; refusing to run it unreviewed`
    };
  }
  if (config.mutationNamePatterns.some((pattern) => pattern.test(toolName))) {
    return config.unknownToolPolicy === "deny" ? {
      action: "deny",
      toolName,
      reason: `tool "${toolName}" looks like a file mutation and is not reviewable; denying by policy`
    } : { action: "pass" };
  }
  return { action: "pass" };
}

// packages/dsh-plugin/src/review-coordinator.ts
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

// packages/shared/src/protocol.ts
var PROTOCOL_VERSION = 1;
var METHODS = {
  hello: "hello",
  decision: "decision",
  autoAccept: "autoAccept",
  ack: "ack",
  ping: "ping",
  reviewRequest: "review/request",
  reviewCancel: "review/cancel",
  reviewMode: "review/mode",
  reviewState: "review/state",
  serverShutdown: "server/shutdown"
};
var RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_FAILED: -32001,
  UNKNOWN_REQUEST: -32002,
  ALREADY_DECIDED: -32003,
  EXPIRED: -32004
};
function encodeFrame(message) {
  return `${JSON.stringify(message)}
`;
}
function splitFrames(buffer) {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}
function isDict(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStr(value) {
  return typeof value === "string";
}
function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isHelloParams(value) {
  if (!isDict(value)) return false;
  if (!isStr(value.token) || value.token.length < 32) return false;
  if (!isNum(value.protocolVersion)) return false;
  const client = value.client;
  if (!isDict(client) || !isStr(client.name) || !isStr(client.version)) return false;
  return true;
}
function isDecisionParams(value) {
  if (!isDict(value)) return false;
  if (!isStr(value.requestId) || value.requestId.length === 0) return false;
  if (!isStr(value.nonce) || value.nonce.length < 16) return false;
  if (value.status !== "accept" && value.status !== "reject") return false;
  if (value.status === "accept" && !isStr(value.finalContent)) return false;
  if (value.finalContent !== void 0 && !isStr(value.finalContent)) return false;
  if (value.reason !== void 0 && !isStr(value.reason)) return false;
  return true;
}
function isAutoAcceptParams(value) {
  if (!isDict(value)) return false;
  return value.scope === "turn" && isNum(value.max) && value.max > 0 && value.max <= 100;
}
function isAckParams(value) {
  return isDict(value) && isStr(value.requestId);
}

// packages/shared/src/review-record.ts
var TRANSITIONS = {
  pending: ["decided", "rejected", "expired", "cancelled", "failed"],
  decided: ["committed", "conflict", "failed"],
  committed: [],
  rejected: [],
  expired: [],
  cancelled: [],
  conflict: [],
  failed: []
};
function canTransition(from, to) {
  return TRANSITIONS[from].includes(to);
}

// packages/shared/src/commit-target.ts
var CommitConflict = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "CommitConflict";
    this.code = code;
  }
};

// packages/shared/src/text.ts
function normalizeLineEndings(content) {
  return content.replaceAll("\r\n", "\n");
}
function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096);
  const crlfCount = sample.split("\r\n").length - 1;
  const lfCount = sample.split("\n").length - 1;
  return crlfCount > lfCount - crlfCount ? "CRLF" : "LF";
}
function restoreLineEndings(content, lineEndings) {
  if (lineEndings === "LF") return content;
  return normalizeLineEndings(content).split("\n").join("\r\n");
}
function countOccurrences(content, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (; ; ) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}
function applyLiteralEdit(content, oldString, newString, replaceAll) {
  const oldNorm = normalizeLineEndings(oldString);
  if (oldNorm.length === 0) return { ok: false, reason: "empty-old", matches: 0 };
  const newNorm = normalizeLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) return { ok: false, reason: "not-found", matches: 0 };
  if (!replaceAll && replacements > 1) return { ok: false, reason: "ambiguous", matches: replacements };
  return { ok: true, content: content.split(oldNorm).join(newNorm), replacements };
}

// packages/shared/src/hash.ts
import { createHash, randomBytes } from "node:crypto";
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// packages/dsh-plugin/src/proposal.ts
import { isAbsolute as isAbsolute2 } from "node:path";
function isString(value) {
  return typeof value === "string";
}
function deny(reason) {
  return { ok: false, deny: true, reason };
}
function passthrough(reason) {
  return { ok: false, passthrough: true, reason };
}
function hasProposalBuilder(toolName) {
  return toolName === "write" || toolName === "edit" || toolName === "str_replace_editor";
}
function buildProposal(input) {
  const { toolName, args, snapshot, maxFileBytes } = input;
  if (toolName === "str_replace_editor") return buildEditorProposal(args, snapshot, maxFileBytes);
  if (toolName === "write") return buildWriteProposal(args, snapshot, maxFileBytes);
  if (toolName === "edit") return buildEditProposal(args, snapshot, maxFileBytes);
  return deny(`no proposal builder for tool "${toolName}"`);
}
function buildWriteProposal(args, snapshot, maxFileBytes) {
  const content = args.content;
  if (!isString(content)) return passthrough("missing write content");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxFileBytes) return deny(`proposed file is ${bytes} bytes, above the ${maxFileBytes}-byte review limit`);
  return {
    ok: true,
    operation: snapshot.exists ? "update" : "create",
    proposedContent: content,
    displayContent: normalizeLineEndings(content),
    lineEndings: snapshot.exists ? snapshot.lineEndings : detectLineEndings(content)
  };
}
function buildEditProposal(args, snapshot, maxFileBytes) {
  const oldString = args.old_string;
  const newString = args.new_string;
  const replaceAll = args.replace_all === true;
  if (!isString(oldString) || !isString(newString)) return passthrough("missing edit strings");
  if (!snapshot.exists || snapshot.content === null) return passthrough("edit target does not exist yet");
  if (Buffer.byteLength(snapshot.content, "utf8") > maxFileBytes) {
    return deny(`target file is above the ${maxFileBytes}-byte review limit`);
  }
  const edited = applyLiteralEdit(snapshot.content, oldString, newString, replaceAll);
  if (!edited.ok) return passthrough(`literal edit would fail: ${edited.reason}`);
  const proposedContent = restoreLineEndings(edited.content, snapshot.lineEndings);
  return {
    ok: true,
    operation: "update",
    proposedContent,
    displayContent: edited.content,
    lineEndings: snapshot.lineEndings
  };
}
function buildEditorProposal(args, snapshot, maxFileBytes) {
  const command = args.command;
  const requestedPath = args.path;
  if (typeof requestedPath !== "string" || !isAbsolute2(requestedPath)) {
    return passthrough("str_replace_editor requires an absolute path");
  }
  if (command === "view") return passthrough("str_replace_editor view is read-only");
  if (command === "create") {
    const fileText = args.file_text;
    if (!isString(fileText)) return passthrough("missing file_text");
    if (snapshot.exists) return passthrough("the file already exists; the tool would reject `create`");
    if (Buffer.byteLength(fileText, "utf8") > maxFileBytes) {
      return deny(`proposed file is ${Buffer.byteLength(fileText, "utf8")} bytes, above the ${maxFileBytes}-byte review limit`);
    }
    return {
      ok: true,
      operation: "create",
      proposedContent: fileText,
      displayContent: normalizeLineEndings(fileText),
      lineEndings: detectLineEndings(fileText)
    };
  }
  const raw = snapshot.rawContent ?? snapshot.content;
  if (!snapshot.exists || raw === null) return passthrough("str_replace_editor target does not exist");
  if (Buffer.byteLength(raw, "utf8") > maxFileBytes) {
    return deny(`target file is above the ${maxFileBytes}-byte review limit`);
  }
  if (command === "str_replace") {
    const oldStr = args.old_str;
    const newStrArg = args.new_str;
    if (!isString(oldStr) || oldStr.length === 0) return passthrough("missing or empty old_str");
    if (newStrArg === null) return passthrough("new_str must be omitted or a string");
    if (newStrArg !== void 0 && !isString(newStrArg)) return passthrough("new_str must be a string");
    const newStr = isString(newStrArg) ? newStrArg : "";
    const first = raw.indexOf(oldStr);
    if (first < 0) return passthrough("old_str does not appear verbatim in the file");
    if (raw.indexOf(oldStr, first + oldStr.length) >= 0) return passthrough("old_str is not unique in the file");
    const edited = raw.slice(0, first) + newStr + raw.slice(first + oldStr.length);
    return {
      ok: true,
      operation: "update",
      proposedContent: edited,
      displayContent: normalizeLineEndings(edited),
      lineEndings: snapshot.lineEndings
    };
  }
  if (command === "insert") {
    const insertLine = args.insert_line;
    const newStr = args.new_str;
    if (typeof insertLine !== "number" || !Number.isInteger(insertLine)) return passthrough("insert_line must be an integer");
    if (newStr === void 0 || newStr === null) return passthrough("new_str is required for insert");
    if (!isString(newStr)) return passthrough("new_str must be a string");
    const lines = raw.split("\n");
    if (insertLine < 0 || insertLine > lines.length) return passthrough("insert_line is out of range");
    const edited = [...lines.slice(0, insertLine), ...newStr.split("\n"), ...lines.slice(insertLine)].join("\n");
    return {
      ok: true,
      operation: "update",
      proposedContent: edited,
      displayContent: normalizeLineEndings(edited),
      lineEndings: snapshot.lineEndings
    };
  }
  return passthrough(`unknown str_replace_editor command: ${String(command)}`);
}

// packages/dsh-plugin/src/review-coordinator.ts
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function pathArgument(toolName) {
  switch (toolName) {
    case "write":
    case "edit":
      return "file_path";
    case "str_replace_editor":
      return "path";
    default:
      return void 0;
  }
}
function successValueFor(toolName, path, operation, before, after) {
  switch (toolName) {
    case "write":
      return { path, operation, before, after };
    case "edit":
      return { path, before: before ?? "", after };
    case "str_replace_editor":
      return operation === "create" ? `New file created successfully at: ${path}` : `The file ${path} has been edited successfully.`;
    default:
      throw new Error(`no success value shape for tool "${toolName}"`);
  }
}
function failureResult(message) {
  return {
    isError: true,
    error: { message },
    content: [{ type: "text", text: `Error: ${message}` }]
  };
}
var ReviewCoordinator = class {
  deps;
  contexts = /* @__PURE__ */ new Map();
  notices = /* @__PURE__ */ new WeakMap();
  ready = Promise.resolve();
  constructor(deps) {
    this.deps = deps;
  }
  /** Runtime wiring supplies the async initialisation (directory + socket). */
  setReady(ready) {
    this.ready = ready;
  }
  get pendingCount() {
    return this.contexts.size;
  }
  get ipcConnected() {
    return this.deps.ipc.connected;
  }
  /** Status snapshot for the `/review` command. */
  status() {
    return {
      connected: this.deps.ipc.connected,
      pending: this.contexts.size,
      stateDir: this.deps.config.stateDir,
      socketPath: this.deps.config.socketPath,
      mode: this.deps.config.mode
    };
  }
  /** Consume the one-shot model notice attached to a committed report. */
  takeNotice(exec) {
    const notice = this.notices.get(exec);
    if (notice !== void 0) this.notices.delete(exec);
    return notice;
  }
  // -------------------------------------------------------------------------
  // Interception
  // -------------------------------------------------------------------------
  async review(exec) {
    try {
      await this.ready;
    } catch (error) {
      return failureResult(`pre-edit review is unavailable: ${messageOf(error)}; the file was NOT modified`);
    }
    const args = exec.arguments ?? {};
    const argName = pathArgument(exec.name);
    const requestedPath = argName === void 0 ? void 0 : args[argName];
    if (typeof requestedPath !== "string" || requestedPath.length === 0) {
      return failureResult(`pre-edit review cannot locate the target path for tool "${exec.name}"; the file was NOT modified`);
    }
    let cwd;
    try {
      cwd = await this.resolveCwd(exec);
    } catch (error) {
      return failureResult(
        `pre-edit review cannot resolve the session workspace: ${messageOf(error)}; the file was NOT modified`
      );
    }
    const mode = this.resolveMode(exec);
    const host = this.deps.createHost(cwd);
    let snapshot;
    try {
      snapshot = await this.deps.target.prepare(host, requestedPath, exec.signal, { mode });
    } catch (error) {
      if (error instanceof CommitConflict) {
        return failureResult(`pre-edit review refused "${requestedPath}": ${error.message}; the file was NOT modified`);
      }
      return failureResult(
        `pre-edit review could not read "${requestedPath}": ${messageOf(error)}; the file was NOT modified`
      );
    }
    const proposal = buildProposal({
      toolName: exec.name,
      args,
      snapshot,
      maxFileBytes: this.deps.config.maxFileBytes
    });
    if (!proposal.ok) {
      if ("passthrough" in proposal) return { passthrough: true };
      return failureResult(proposal.reason);
    }
    const requestId = randomUUID();
    const nonce = randomHex(32);
    const now = Date.now();
    const session = exec.agent?.session;
    const hint = languageHintFor(snapshot.displayPath);
    const record = {
      requestId,
      nonce,
      protocolVersion: 1,
      createdAt: now,
      expiresAt: now + this.deps.config.approvalTimeoutMs,
      sessionId: String(session?.id ?? "unknown"),
      sessionLabel: `${basename(cwd)}#${String(session?.id ?? "unknown").slice(0, 8)}`,
      ...exec.agent?.id !== void 0 ? { agentId: String(exec.agent.id) } : {},
      workspaceRoot: cwd,
      toolName: exec.name,
      callId: String(exec.callId),
      operation: proposal.operation,
      targetKind: this.deps.target.kind,
      displayPath: snapshot.displayPath,
      absolutePath: snapshot.absolutePath,
      before: snapshot.content,
      beforeSha256: snapshot.sha256,
      proposed: proposal.displayContent,
      proposedSha256: sha256Hex(proposal.proposedContent),
      lineEndings: snapshot.lineEndings,
      mode,
      state: "pending"
    };
    await this.deps.store.create(record);
    const entry = { requestId, exec, snapshot, proposal, host, record };
    this.contexts.set(requestId, entry);
    const params = {
      requestId,
      nonce,
      protocolVersion: 1,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      sessionId: record.sessionId,
      sessionLabel: record.sessionLabel,
      toolName: exec.name,
      callId: record.callId,
      operation: proposal.operation,
      displayPath: record.displayPath,
      absolutePath: record.absolutePath,
      isNewFile: snapshot.isNewFile,
      ...hint !== void 0 ? { languageHint: hint } : {},
      before: snapshot.content,
      after: proposal.displayContent,
      beforeSha256: record.beforeSha256,
      afterSha256: record.proposedSha256,
      targetKind: record.targetKind,
      mode
    };
    try {
      const connected = await this.deps.ipc.waitForClient(this.deps.config.clientConnectTimeoutMs, exec.signal);
      if (!connected) {
        if (this.deps.config.fallback === "dsh-approval") return await this.fallbackApproval(entry);
        await this.transitionSafe(entry, "expired", "NO_CLIENT");
        return failureResult(
          "Pre-edit review needs VS Code, but no review client is connected. The file was NOT modified. Open VS Code with the DeepSeek Pre-edit Review extension and retry the same edit."
        );
      }
      const result = await this.deps.ipc.request(params, {
        timeoutMs: this.deps.config.approvalTimeoutMs,
        signal: exec.signal
      });
      return entry.toolResult ?? failureResult(`pre-edit review finished as "${result.outcome}" without a tool result; the file was NOT modified`);
    } catch (error) {
      const aborted = exec.signal.aborted;
      await this.transitionSafe(entry, aborted ? "cancelled" : "expired", aborted ? "CANCELLED" : "REVIEW_FAILED");
      return failureResult(
        `pre-edit review did not complete (${messageOf(error)}); the file was NOT modified. Re-read the file and retry if the change is still required.`
      );
    } finally {
      this.contexts.delete(requestId);
    }
  }
  // -------------------------------------------------------------------------
  // Decision handling (invoked by the IPC server while replying to a decision)
  // -------------------------------------------------------------------------
  async handleDecision(decision) {
    const entry = this.contexts.get(decision.requestId);
    if (entry === void 0) return { outcome: "already-decided" };
    if (entry.record.state !== "pending") return { outcome: "already-decided" };
    if (decision.status === "reject") {
      await this.transitionSafe(entry, "rejected", void 0, {
        status: "reject",
        by: decision.by,
        ...decision.reason !== void 0 ? { reason: decision.reason } : {},
        decidedAt: Date.now()
      });
      entry.toolResult = failureResult(
        `The user rejected the proposed edit to "${entry.record.displayPath}". The file was NOT modified. ` + (decision.reason === void 0 || decision.reason.length === 0 ? "Ask what should change before proposing again." : `User reason: ${decision.reason}`)
      );
      await this.audit({ event: "review/rejected", requestId: entry.requestId, displayPath: entry.record.displayPath });
      return { outcome: "rejected" };
    }
    const finalDisplay = decision.finalContent ?? entry.proposal.displayContent;
    const edited = finalDisplay !== entry.proposal.displayContent;
    const finalContent = edited ? restoreLineEndings(finalDisplay, entry.snapshot.lineEndings) : entry.proposal.proposedContent;
    await this.deps.store.transition(entry.requestId, "decided", {
      decision: {
        status: "accept",
        by: decision.by,
        finalContentSha256: sha256Hex(finalContent),
        decidedAt: Date.now()
      }
    });
    entry.record = await this.deps.store.get(entry.requestId) ?? entry.record;
    const precondition = entry.snapshot.exists ? { kind: "replaceIfVersion", version: entry.snapshot.version } : { kind: "createIfAbsent" };
    try {
      const commit = await this.deps.target.commit(
        entry.host,
        entry.snapshot,
        finalContent,
        precondition,
        entry.exec.signal,
        entry.exec
      );
      await this.deps.store.transition(entry.requestId, "committed", { commit: { at: Date.now() } });
      entry.record = await this.deps.store.get(entry.requestId) ?? entry.record;
      entry.toolResult = {
        isError: false,
        value: successValueFor(
          entry.record.toolName,
          entry.snapshot.absolutePath,
          commit.operation,
          entry.snapshot.content,
          commit.after
        )
      };
      if (edited && this.deps.config.noticeOnUserEdit) {
        this.notices.set(
          entry.exec,
          `[pre-edit-review] The user EDITED the proposal before accepting. The file on disk is the user's final version, not your original proposal; before making further changes, re-read "${entry.record.displayPath}".`
        );
      }
      await this.audit({
        event: "review/committed",
        requestId: entry.requestId,
        displayPath: entry.record.displayPath,
        edited,
        finalSha256: sha256Hex(normalizeLineEndings(finalContent))
      });
      return { outcome: "committed" };
    } catch (error) {
      if (error instanceof CommitConflict) {
        await this.transitionSafe(entry, "conflict", error.code, void 0, { code: error.code, message: error.message });
        entry.toolResult = failureResult(
          `The file "${entry.record.displayPath}" changed while it was being approved, so the approved change was NOT written (${error.code}: ${error.message}). Re-read the file and propose the change again against the current content.`
        );
        await this.audit({ event: "review/conflict", requestId: entry.requestId, code: error.code });
        return { outcome: "conflict", detail: { code: error.code, message: error.message } };
      }
      await this.transitionSafe(entry, "failed", "COMMIT_FAILED");
      entry.toolResult = failureResult(
        `pre-edit review could not write "${entry.record.displayPath}": ${messageOf(error)}. The file was NOT modified.`
      );
      await this.audit({ event: "review/failed", requestId: entry.requestId });
      return { outcome: "failed", detail: { message: messageOf(error) } };
    }
  }
  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  async fallbackApproval(entry) {
    const approval = this.deps.ctx.get("approval");
    if (approval === void 0) {
      await this.transitionSafe(entry, "expired", "NO_CLIENT");
      return failureResult("Pre-edit review needs VS Code and no approval channel is available; the file was NOT modified.");
    }
    let outcome;
    try {
      outcome = await approval.request({
        ...entry.exec.agent !== void 0 ? { agent: entry.exec.agent } : {},
        toolName: entry.record.toolName,
        callId: entry.record.callId,
        reason: `pre-edit review (VS Code offline): allow the change to ${entry.record.displayPath}?`,
        signal: entry.exec.signal
      });
    } catch (error) {
      await this.transitionSafe(entry, "failed", "FALLBACK_UNAVAILABLE");
      return failureResult(`pre-edit review fallback approval failed: ${messageOf(error)}; the file was NOT modified`);
    }
    if (outcome !== "allowed-once") {
      await this.transitionSafe(entry, outcome === "cancelled" ? "cancelled" : "rejected", "FALLBACK_DENIED");
      return failureResult(
        "The user did not approve the change through the fallback approval channel; the file was NOT modified."
      );
    }
    const precondition = entry.snapshot.exists ? { kind: "replaceIfVersion", version: entry.snapshot.version } : { kind: "createIfAbsent" };
    try {
      const commit = await this.deps.target.commit(
        entry.host,
        entry.snapshot,
        entry.proposal.proposedContent,
        precondition,
        entry.exec.signal,
        entry.exec
      );
      await this.transitionSafe(entry, "committed");
      return {
        isError: false,
        value: successValueFor(
          entry.record.toolName,
          entry.snapshot.absolutePath,
          commit.operation,
          entry.snapshot.content,
          commit.after
        )
      };
    } catch (error) {
      await this.transitionSafe(entry, "conflict", error instanceof CommitConflict ? error.code : "COMMIT_FAILED");
      return failureResult(`pre-edit review could not write "${entry.record.displayPath}": ${messageOf(error)}`);
    }
  }
  async transitionSafe(entry, next, code, decision, commit) {
    try {
      entry.record = await this.deps.store.transition(entry.requestId, next, {
        ...decision !== void 0 ? { decision } : {},
        ...commit !== void 0 || code !== void 0 ? { commit: { at: Date.now(), ...code !== void 0 ? { code } : {}, ...commit } } : {}
      });
    } catch (error) {
      this.deps.ctx.logger?.warn(`[pre-edit-review] state transition to ${next} failed: ${messageOf(error)}`);
    }
  }
  async audit(event) {
    try {
      await this.deps.store.audit(event);
    } catch {
    }
  }
  async resolveCwd(exec) {
    const workingDirectory = this.deps.ctx.get("workingDirectory");
    if (workingDirectory !== void 0 && exec.agent !== void 0) {
      return await workingDirectory.ensure(exec.agent, exec.signal);
    }
    return process.cwd();
  }
  resolveMode(exec) {
    const policy = this.deps.ctx.get("sandboxPolicy");
    if (policy === void 0) return "tool-level";
    try {
      const resolved = policy.resolve({ ...exec.agent?.session !== void 0 ? { session: exec.agent.session } : {} });
      return resolved.mode === "read-only" ? "strict" : "tool-level";
    } catch {
      return "tool-level";
    }
  }
};
function languageHintFor(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return void 0;
  const ext = path.slice(dot + 1).toLowerCase();
  const map = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    css: "css",
    scss: "scss",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    sh: "shellscript",
    toml: "toml",
    sql: "sql",
    xml: "xml"
  };
  return map[ext];
}

// packages/dsh-plugin/src/gate.ts
function isPassthrough(result) {
  return "passthrough" in result;
}
function lookupDefinition(ctx, name2) {
  try {
    return ctx.tools.get(name2);
  } catch {
    return void 0;
  }
}
function installGate(deps) {
  const { ctx, config, coordinator, killSwitch, pause } = deps;
  return ctx.on(
    "tools/execute",
    async (exec, next) => {
      if (killSwitch.active()) return next();
      if (pause.isPaused(exec.agent?.session)) return next();
      let classification;
      try {
        classification = classify({
          toolName: exec.name,
          args: exec.arguments,
          definition: lookupDefinition(ctx, exec.name),
          config,
          hasBuilder: hasProposalBuilder
        });
      } catch (error) {
        const looksMutating = config.reviewTools.includes(exec.name);
        if (!looksMutating) return next();
        return failureResult(
          `pre-edit review could not classify "${exec.name}" (${error instanceof Error ? error.message : String(error)}); the call was NOT executed`
        );
      }
      if (classification.action === "pass") return next();
      if (classification.action === "deny") return failureResult(classification.reason);
      try {
        const result = await coordinator.review(exec);
        return isPassthrough(result) ? next() : result;
      } catch (error) {
        return failureResult(
          `pre-edit review failed before dispatch (${error instanceof Error ? error.message : String(error)}); the file was NOT modified`
        );
      }
    },
    { prepend: true }
  );
}

// packages/dsh-plugin/src/kill-switch.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
function createKillSwitch(stateDir, cacheMs = 1e3, now = () => Date.now()) {
  const path = join(stateDir, "DISABLED");
  let checkedAt = -Infinity;
  let active = false;
  return {
    path,
    active() {
      const at = now();
      if (at - checkedAt >= cacheMs) {
        checkedAt = at;
        try {
          active = existsSync(path);
        } catch {
          active = false;
        }
      }
      return active;
    }
  };
}

// packages/dsh-plugin/src/pause.ts
function createPauseRegistry() {
  const sessions = /* @__PURE__ */ new Set();
  return {
    isPaused(session) {
      return session !== void 0 && sessions.has(session);
    },
    set(session, paused) {
      if (paused) sessions.add(session);
      else sessions.delete(session);
    },
    anyPaused() {
      return sessions.size > 0;
    },
    activeCount() {
      return sessions.size;
    }
  };
}

// packages/dsh-plugin/src/ipc/server.ts
import { createHash as createHash2, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { connect as netConnect, createServer } from "node:net";
import { join as join2 } from "node:path";
var MAX_FRAME_BYTES = 8 * 1024 * 1024;
function probeSocket(path, timeoutMs = 300) {
  return new Promise((resolve2) => {
    const socket = netConnect(path);
    const done = (value) => {
      socket.destroy();
      resolve2(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}
function tokenDigest(text) {
  return createHash2("sha256").update(text, "utf8").digest();
}
var IpcServer = class {
  options;
  server;
  socket;
  buffer = "";
  authed = false;
  pending = /* @__PURE__ */ new Map();
  now;
  token = "";
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }
  get connected() {
    return this.socket !== void 0 && this.authed;
  }
  get pendingCount() {
    return this.pending.size;
  }
  get socketPath() {
    return this.options.socketPath;
  }
  /** Create the state directory, publish a fresh token, and listen. */
  async start() {
    await mkdir(this.options.stateDir, { recursive: true, mode: 448 });
    this.token = randomBytes2(32).toString("hex");
    const tokenPath = join2(this.options.stateDir, "token");
    await writeFile(tokenPath, this.token, { encoding: "utf8", mode: 384 });
    await chmod(tokenPath, 384).catch(() => void 0);
    await this.listen();
  }
  async listen() {
    const connect = () => new Promise((resolve2, reject) => {
      const server = createServer((socket) => this.accept(socket));
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener("error", reject);
        server.on("error", () => void 0);
        resolve2();
      });
      this.server = server;
    });
    try {
      await connect();
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (await probeSocket(this.options.socketPath)) {
        throw new Error(
          `another pre-edit review host is already listening on ${this.options.socketPath}; share one profile or configure a different stateDir/socketPath`
        );
      }
      await unlink(this.options.socketPath).catch(() => void 0);
      await connect();
    }
    await chmod(this.options.socketPath, 384).catch(() => void 0);
  }
  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(new Error("IPC server stopped"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = void 0;
    await new Promise((resolve2) => {
      if (this.server === void 0) return resolve2();
      this.server.close(() => resolve2());
    });
    this.server = void 0;
    await unlink(this.options.socketPath).catch(() => void 0);
  }
  /** Read the token the extension must present (also used by tooling/tests). */
  async readToken() {
    return readFile(join2(this.options.stateDir, "token"), "utf8");
  }
  /** Wait until a client completes the handshake, or the deadline passes. */
  async waitForClient(timeoutMs, signal) {
    if (this.connected) return true;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (this.connected) return true;
      if (signal.aborted) return false;
      await new Promise((resolve2) => setTimeout(resolve2, 100));
    }
    return this.connected;
  }
  accept(socket) {
    if (this.socket !== void 0) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.buffer = "";
    this.authed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
  }
  onClose() {
    const wasConnected = this.connected;
    this.socket = void 0;
    this.authed = false;
    const outstanding = [...this.pending.values()];
    this.pending.clear();
    for (const pending of outstanding) {
      clearTimeout(pending.timer);
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(new Error("review client disconnected"));
    }
    if (wasConnected) this.options.onClientChanged?.(false);
  }
  onData(chunk) {
    this.buffer += chunk;
    const { lines, rest } = splitFrames(this.buffer);
    this.buffer = rest;
    for (const line of lines) this.onFrame(line);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(null, RPC_ERRORS.INVALID_REQUEST, "frame exceeds the maximum size");
      this.socket?.destroy();
    }
  }
  send(message) {
    this.socket?.write(encodeFrame(message));
  }
  reply(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }
  fail(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
  onFrame(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(null, RPC_ERRORS.PARSE_ERROR, "invalid JSON frame");
      return;
    }
    if (message?.method === METHODS.hello) {
      if (!isHelloParams(message.params) || message.params.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, "unsupported protocol or malformed hello");
        this.socket?.destroy();
        return;
      }
      const presented = tokenDigest(message.params.token);
      const expected = tokenDigest(this.token);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, "invalid token");
        this.socket?.destroy();
        return;
      }
      this.authed = true;
      this.options.onClientChanged?.(true);
      this.reply(message.id, {
        ok: true,
        serverVersion: this.options.serverVersion,
        stateDir: this.options.stateDir,
        paused: this.options.mode?.() === true
      });
      return;
    }
    if (!this.authed) {
      this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, "hello required before any other method");
      return;
    }
    switch (message?.method) {
      case METHODS.decision:
        void this.onDecisionFrame(message);
        return;
      case METHODS.ack:
        this.reply(message.id, { ok: isAckParams(message.params) });
        return;
      case METHODS.ping:
        this.reply(message.id, { pong: true, now: this.now() });
        return;
      case METHODS.autoAccept:
        if (isAutoAcceptParams(message.params)) this.options.onAutoAccept?.();
        this.reply(message.id, { ok: true });
        return;
      default:
        this.fail(message?.id ?? null, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${String(message?.method)}`);
    }
  }
  async onDecisionFrame(message) {
    if (!isDecisionParams(message?.params)) {
      this.fail(message?.id ?? null, RPC_ERRORS.INVALID_PARAMS, "invalid decision params");
      return;
    }
    const params = message.params;
    const pending = this.pending.get(params.requestId);
    if (pending === void 0) {
      this.reply(message.id, { ok: true, outcome: "already-decided" });
      return;
    }
    if (params.nonce !== pending.nonce) {
      this.fail(message?.id ?? null, RPC_ERRORS.AUTH_FAILED, "decision nonce does not match the pending review");
      return;
    }
    this.pending.delete(params.requestId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    const decision = {
      requestId: params.requestId,
      status: params.status,
      ...params.finalContent !== void 0 ? { finalContent: params.finalContent } : {},
      ...params.reason !== void 0 ? { reason: params.reason } : {},
      by: "user"
    };
    let handling;
    try {
      handling = await this.options.handleDecision(decision);
    } catch (error) {
      handling = { outcome: "failed", detail: { message: error instanceof Error ? error.message : String(error) } };
    }
    this.reply(message.id, { ok: true, ...handling });
    pending.resolve({ decision, outcome: handling });
  }
  /**
   * Ask the client to review one request.
   * Resolves only after the decision was handled (so `outcome` is final);
   * rejects on timeout, abort, disconnect, or server shutdown.
   */
  request(params, options) {
    return new Promise((resolve2, reject) => {
      if (!this.connected) {
        reject(new Error("no review client connected"));
        return;
      }
      if (options.signal.aborted) {
        reject(new Error("review cancelled"));
        return;
      }
      const onAbort = () => {
        this.cancel(params.requestId, "cancelled");
        reject(new Error("review cancelled"));
      };
      const timer = setTimeout(() => {
        this.cancel(params.requestId, "timeout");
        reject(new Error(`review timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      this.pending.set(params.requestId, {
        requestId: params.requestId,
        nonce: params.nonce,
        resolve: resolve2,
        reject,
        timer,
        signal: options.signal,
        onAbort
      });
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.send({ jsonrpc: "2.0", method: METHODS.reviewRequest, params });
    });
  }
  /** Push the current review-paused state to the client. */
  notifyMode(params) {
    if (!this.connected) return;
    this.send({ jsonrpc: "2.0", method: METHODS.reviewMode, params });
  }
  /** Withdraw an outstanding request (timeout, cancellation, disconnect). */
  cancel(requestId, reason) {
    const pending = this.pending.get(requestId);
    if (pending === void 0) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    this.send({ jsonrpc: "2.0", method: METHODS.reviewCancel, params: { requestId, reason } });
  }
};

// packages/dsh-plugin/src/recovery.ts
function snapshotFor(record) {
  return {
    displayPath: record.displayPath,
    absolutePath: record.absolutePath,
    exists: true,
    isNewFile: false,
    content: null,
    sha256: null,
    version: void 0,
    lineEndings: "LF",
    mode: record.mode
  };
}
async function reconcileStaging(store, target, host, signal) {
  const counts = { expired: 0, committed: 0, conflict: 0, unchanged: 0 };
  for (const record of await store.list()) {
    if (record.state === "pending") {
      await store.transition(record.requestId, "expired", {
        commit: { at: Date.now(), code: "RECOVERED_PENDING", message: "host restarted before a decision" }
      });
      counts.expired += 1;
      continue;
    }
    if (record.state !== "decided") {
      counts.unchanged += 1;
      continue;
    }
    const expected = record.decision?.finalContentSha256;
    if (expected === void 0) {
      await store.transition(record.requestId, "conflict", {
        commit: { at: Date.now(), code: "RECOVERED_NO_DECISION_HASH", message: "accepted decision had no content hash" }
      });
      counts.conflict += 1;
      continue;
    }
    let actual = null;
    try {
      const inspected = await target.inspect(host, snapshotFor(record), signal);
      actual = inspected.sha256;
    } catch (error) {
      if (!(error instanceof CommitConflict)) throw error;
      actual = null;
    }
    if (actual !== null && actual === expected) {
      await store.transition(record.requestId, "committed", {
        commit: { at: Date.now(), code: "RECOVERED_COMMITTED", message: "write had landed before the host restarted" }
      });
      counts.committed += 1;
    } else {
      await store.transition(record.requestId, "conflict", {
        commit: {
          at: Date.now(),
          code: "RECOVERED_MISMATCH",
          message: "accepted content does not match the file on disk; nothing was re-committed"
        }
      });
      counts.conflict += 1;
    }
  }
  return counts;
}

// packages/dsh-plugin/src/staging/store.ts
import { chmod as chmod2, mkdir as mkdir2, open, readFile as readFile2, readdir, rename, unlink as unlink2 } from "node:fs/promises";
import { join as join3 } from "node:path";
var StagingStore = class _StagingStore {
  dir;
  now;
  constructor(options) {
    this.dir = options.dir;
    this.now = options.now ?? (() => Date.now());
  }
  static async open(options) {
    const store = new _StagingStore(options);
    await store.init();
    return store;
  }
  /** Create the state directories with owner-only permissions. */
  async init() {
    await mkdir2(join3(this.dir, "staging"), { recursive: true, mode: 448 });
    await mkdir2(join3(this.dir, "audit"), { recursive: true, mode: 448 });
  }
  recordPath(requestId) {
    return join3(this.dir, "staging", `${requestId}.json`);
  }
  async create(record) {
    const path = this.recordPath(record.requestId);
    const temp = `${path}.${randomHex(6)}.tmp`;
    const handle = await open(temp, "w", 384);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }
  async get(requestId) {
    try {
      const raw = await readFile2(this.recordPath(requestId), "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") return void 0;
      throw error;
    }
  }
  async list() {
    const entries = await readdir(join3(this.dir, "staging")).catch(() => []);
    const records = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.get(entry.slice(0, -".json".length));
      if (record !== void 0) records.push(record);
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }
  /**
   * Apply one transition. Throws when the transition is illegal, which makes
   * duplicate decisions and late decisions fail loudly instead of corrupting
   * state. The caller decides which IPC error to return.
   */
  async transition(requestId, next, patch = {}) {
    const current = await this.get(requestId);
    if (current === void 0) throw new Error(`staging record ${requestId} not found`);
    if (!canTransition(current.state, next)) {
      throw new Error(`illegal review transition ${current.state} -> ${next} for ${requestId}`);
    }
    const updated = { ...current, ...patch, state: next };
    await this.create(updated);
    return updated;
  }
  /** Crash recovery: every non-terminal record becomes `expired`; never commits. */
  async expirePending() {
    const expired = [];
    for (const record of await this.list()) {
      if (record.state !== "pending") continue;
      expired.push(
        await this.transition(record.requestId, "expired", {
          commit: { at: this.now(), code: "RECOVERED_PENDING", message: "host restarted before a decision" }
        })
      );
    }
    return expired;
  }
  async remove(requestId) {
    await unlink2(this.recordPath(requestId)).catch(() => void 0);
  }
  /** Append one audit line (hashes and paths only, never file content). */
  async audit(event) {
    const now = new Date(this.now());
    const file = join3(this.dir, "audit", `${now.toISOString().slice(0, 7)}.jsonl`);
    await chmod2(file, 384).catch(() => void 0);
    const handle = await open(file, "a", 384);
    try {
      await handle.writeFile(`${JSON.stringify({ at: now.toISOString(), ...event })}
`, "utf8");
    } finally {
      await handle.close();
    }
  }
};

// packages/dsh-plugin/src/targets/direct-workspace.ts
import { relative } from "node:path";
function versionOf(info) {
  return info?.version;
}
function fsCode(error) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : void 0;
  }
  return void 0;
}
function mapFsError(error) {
  const code = fsCode(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "FS_STALE_VERSION":
    case "FS_NOT_OBSERVED":
    case "FS_SANDBOX_DENIED":
    case "FS_NOT_TEXT":
      return new CommitConflict(code, message);
    default:
      return new CommitConflict("UNKNOWN", message);
  }
}
function displayPathOf(root, absolutePath) {
  const rel = relative(root, absolutePath);
  return rel.length === 0 ? absolutePath : rel;
}
var DirectWorkspaceTarget = class {
  kind = "direct-workspace";
  async prepare(host, requestedPath, signal, options) {
    const root = await host.workspaceRoot();
    const rootTarget = await host.resolve(root, { signal });
    const target = await host.resolve(requestedPath, { cwd: root, signal });
    if (!host.contains(rootTarget, target)) {
      throw new CommitConflict("OUT_OF_SCOPE", `path "${requestedPath}" is outside the session workspace`);
    }
    const first = await host.stat(target, signal);
    const raw = first === void 0 ? null : await host.readText(target, signal);
    const second = await host.stat(target, signal);
    if (versionOf(first) !== versionOf(second)) {
      throw new CommitConflict("FS_STALE_VERSION", "file changed while the proposal was being read; retry the read");
    }
    const absolutePath = host.processPath(target);
    const content = raw === null ? null : normalizeLineEndings(raw);
    return {
      displayPath: displayPathOf(root, absolutePath),
      absolutePath,
      exists: raw !== null,
      isNewFile: raw === null,
      content,
      rawContent: raw,
      sha256: content === null ? null : sha256Hex(content),
      version: second?.version,
      lineEndings: raw === null ? "LF" : detectLineEndings(raw),
      mode: options?.mode ?? "tool-level"
    };
  }
  async commit(host, snapshot, finalContent, precondition, signal, actor) {
    const root = await host.workspaceRoot();
    const rootTarget = await host.resolve(root, { signal });
    const target = await host.resolve(snapshot.absolutePath, { signal });
    if (!host.contains(rootTarget, target)) {
      throw new CommitConflict("OUT_OF_SCOPE", `path "${snapshot.absolutePath}" is outside the session workspace`);
    }
    let outcome;
    try {
      outcome = await host.writeText(target, finalContent, precondition, signal, {
        mode: "workspace-write",
        workspaceRoot: root
      });
    } catch (error) {
      throw mapFsError(error);
    }
    host.observe(target, outcome.version, actor);
    return {
      ok: true,
      operation: outcome.operation,
      before: outcome.before,
      after: normalizeLineEndings(outcome.after),
      versionAfter: outcome.version
    };
  }
  async inspect(host, snapshot, signal) {
    const target = await host.resolve(snapshot.absolutePath, { signal });
    const info = await host.stat(target, signal);
    if (info === void 0) return { exists: false, sha256: null, version: void 0 };
    const raw = await host.readText(target, signal);
    const content = normalizeLineEndings(raw);
    return { exists: true, sha256: sha256Hex(content), version: info.version };
  }
};

// packages/dsh-plugin/src/targets/git-worktree.ts
var NotImplementedError = class extends Error {
  code = "NOT_IMPLEMENTED";
  constructor(message) {
    super(message);
    this.name = "NotImplementedError";
  }
};
var MESSAGE = "GitWorktreeTarget is reserved for the isolated-worktree architecture and is not implemented in this release";
var GitWorktreeTarget = class {
  kind = "git-worktree";
  async prepare(_host, _requestedPath, _signal, _options) {
    throw new NotImplementedError(MESSAGE);
  }
  async commit(_host, _snapshot, _finalContent, _precondition, _signal, _actor) {
    throw new NotImplementedError(MESSAGE);
  }
  async inspect(_host, _snapshot, _signal) {
    throw new NotImplementedError(MESSAGE);
  }
};

// packages/dsh-plugin/src/targets/index.ts
function createCommitTarget(kind) {
  switch (kind) {
    case "direct-workspace":
      return new DirectWorkspaceTarget();
    case "git-worktree":
      return new GitWorktreeTarget();
    default:
      throw new Error(`unknown commit target kind: ${String(kind)}`);
  }
}
function createCommitTargetHost(ctx, cwd) {
  return {
    resolve: (path, options) => ctx.fs.resolve(path, { cwd, signal: options?.signal }),
    contains: (parent, child) => ctx.fs.contains(parent, child),
    stat: (target, signal) => ctx.fs.stat(target, signal),
    readText: (target, signal) => ctx.fs.readText(target, signal),
    writeText: (target, content, expected, signal, sandboxPolicy) => ctx.fs.writeText(target, content, expected, signal, sandboxPolicy),
    processPath: (target) => ctx.fs.processPath(target),
    observe: (target, version, actor) => {
      ctx.emit("fs/observed", target, { kind: "present", version }, actor);
    },
    workspaceRoot: async () => cwd
  };
}

// packages/dsh-plugin/src/runtime.ts
var PLUGIN_VERSION = "0.2.1";
function createRuntime(ctx, config, logger) {
  const store = new StagingStore({ dir: config.stateDir });
  const pause = createPauseRegistry();
  let coordinatorRef;
  const ipc = new IpcServer({
    stateDir: config.stateDir,
    socketPath: config.socketPath,
    serverVersion: PLUGIN_VERSION,
    handleDecision: (decision) => {
      if (coordinatorRef === void 0) {
        return Promise.resolve({ outcome: "failed", detail: { message: "review runtime is not ready" } });
      }
      return coordinatorRef.handleDecision(decision);
    },
    onClientChanged: (connected) => {
      logger.info(`[pre-edit-review] review client ${connected ? "connected" : "disconnected"}`);
      if (connected) ipc.notifyMode({ paused: pause.anyPaused() });
    },
    mode: () => pause.anyPaused()
  });
  const target = createCommitTarget("direct-workspace");
  const coordinator = new ReviewCoordinator({
    ctx,
    config,
    store,
    ipc,
    target,
    createHost: (cwd) => createCommitTargetHost(ctx, cwd)
  });
  coordinatorRef = coordinator;
  const ready = (async () => {
    await store.init();
    await ipc.start();
    const expired = await store.expirePending();
    if (expired.length > 0) {
      logger.warn(`[pre-edit-review] marked ${expired.length} pending review(s) expired after restart; nothing was committed`);
    }
    try {
      const counts = await reconcileStaging(
        store,
        target,
        createCommitTargetHost(ctx, process.cwd()),
        new AbortController().signal
      );
      if (counts.committed > 0 || counts.conflict > 0) {
        logger.warn(
          `[pre-edit-review] crash reconciliation: ${counts.committed} accepted review(s) had already landed, ${counts.conflict} conflicted; nothing was re-committed`
        );
      }
    } catch (error) {
      logger.error(`[pre-edit-review] crash reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  coordinator.setReady(ready);
  ready.catch((error) => {
    logger.error(`[pre-edit-review] runtime failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
  return {
    config,
    store,
    ipc,
    coordinator,
    pause,
    ready,
    dispose: async () => {
      await ipc.stop();
    }
  };
}

// packages/dsh-plugin/src/history.ts
import { readdir as readdir2, readFile as readFile3 } from "node:fs/promises";
import { join as join4 } from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseAuditLines(lines, limit) {
  const entries = [];
  for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
    const line = lines[index]?.trim();
    if (line === void 0 || line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed["event"] !== "string") continue;
    entries.push({
      ...typeof parsed["at"] === "string" ? { at: parsed["at"] } : {},
      event: parsed["event"],
      ...typeof parsed["requestId"] === "string" ? { requestId: parsed["requestId"] } : {},
      ...typeof parsed["displayPath"] === "string" ? { displayPath: parsed["displayPath"] } : {},
      ...typeof parsed["edited"] === "boolean" ? { edited: parsed["edited"] } : {},
      ...typeof parsed["code"] === "string" ? { code: parsed["code"] } : {},
      ...typeof parsed["finalSha256"] === "string" ? { finalSha256: parsed["finalSha256"] } : {}
    });
  }
  return entries;
}
async function readAuditHistory(stateDir, limit) {
  const auditDir = join4(stateDir, "audit");
  let files;
  try {
    files = (await readdir2(auditDir)).filter((name2) => name2.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files) {
    if (entries.length >= limit) break;
    let lines;
    try {
      lines = (await readFile3(join4(auditDir, file), "utf8")).split("\n");
    } catch {
      continue;
    }
    entries.push(...parseAuditLines(lines, limit - entries.length));
  }
  return entries;
}
function formatHistory(entries, limit = 10) {
  if (entries.length === 0) return "No review history yet.";
  return entries.slice(0, limit).map((entry) => {
    const when = entry.at === void 0 ? "?" : entry.at.slice(5, 19).replace("T", " ");
    const what = (entry.event ?? "?").replace(/^review\//, "");
    const path = entry.displayPath ?? "";
    const flags = [entry.edited === true ? "edited" : "", entry.code ?? ""].filter((value) => value.length > 0);
    return `${when}  ${what.padEnd(12)} ${path}${flags.length > 0 ? `  [${flags.join(", ")}]` : ""}`;
  }).join("\n");
}

// packages/dsh-plugin/src/index.ts
var name = "pre-edit-review";
var inject = ["fs", "tools"];
var PROMPT_SECTION = `File changes are reviewed before they are written. Call write/edit normally; the user reviews each change as an editable diff in VS Code and may accept it, edit it, or reject it.

- If a change is rejected, the file was NOT modified: ask what should change before proposing again.
- If the file changed while it was being reviewed, the approved change is NOT written: re-read the file and propose again against the current content.
- Do not try to bypass the review (no shell redirection, script, or indirect write) to make a change land.
- If the user edited your proposal before accepting, re-read the file before your next change; the user's version is what landed.`;
function checkHostCapabilities(ctx) {
  try {
    const fs = ctx.fs;
    if (typeof fs?.resolve !== "function" || typeof fs?.readText !== "function" || typeof fs?.writeText !== "function") {
      return "the filesystem service (ctx.fs) is not usable";
    }
    const tools = ctx.tools;
    if (typeof tools?.get !== "function" || typeof tools?.register !== "function") {
      return "the tool registry (ctx.tools) is not usable";
    }
    return void 0;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger ?? {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message)
  };
  let config;
  try {
    config = normalizeConfig(rawConfig);
  } catch (error) {
    logger.error(`[pre-edit-review] invalid config: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!config.enabled) {
    logger.info("[pre-edit-review] disabled by config");
    return;
  }
  const capabilityProblem = checkHostCapabilities(ctx);
  if (capabilityProblem !== void 0) {
    logger.error(
      `[pre-edit-review] NOT mounting the review gate: ${capabilityProblem}. The plugin stays inert so tool calls keep working; fix the composition and reinstall.`
    );
    return;
  }
  let runtime;
  try {
    runtime = createRuntime(ctx, config, logger);
  } catch (error) {
    logger.error(`[pre-edit-review] failed to assemble runtime: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const killSwitch = createKillSwitch(config.stateDir);
  const disposers = [];
  disposers.push(installGate({ ctx, config, coordinator: runtime.coordinator, killSwitch, pause: runtime.pause }));
  disposers.push(installPostExecuteNotice(ctx, runtime.coordinator));
  installCommands(ctx, runtime, logger);
  installPromptSection(ctx);
  logger.info(
    `[pre-edit-review] mounted v${PLUGIN_VERSION} (mode=${config.mode}, reviewTools=${config.reviewTools.join(",")}, socket=${config.socketPath}, killSwitch=${killSwitch.path})`
  );
  if (killSwitch.active()) {
    logger.warn(`[pre-edit-review] kill switch is ACTIVE (${killSwitch.path}); every review is bypassed until it is removed`);
  }
  const dispose = () => {
    for (const disposeOne of disposers.splice(0)) {
      try {
        disposeOne();
      } catch {
      }
    }
    void runtime.dispose();
  };
  if (ctx.effect !== void 0) {
    ctx.effect(() => dispose, "pre-edit-review teardown");
  }
}
function installPostExecuteNotice(ctx, coordinator) {
  return ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      const notice = coordinator.takeNotice(exec);
      if (notice === void 0 || decision?.kind !== "accept") return decision;
      const base = Array.isArray(decision.content) ? decision.content : Array.isArray(result?.content) ? result.content : [];
      return { ...decision, content: [...base, { type: "text", text: notice }] };
    },
    { prepend: false }
  );
}
function installCommands(ctx, runtime, logger) {
  if (ctx.inject === void 0) return;
  ctx.inject(["commands"], (sub) => {
    sub.commands.register({
      name: "review",
      description: "Pre-edit review status; pause/resume review or switch between strict and balanced file policy",
      input: { hint: "[status|on|off|strict|balanced|history [n]]" },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? "").trim().toLowerCase();
        const config = runtime.config;
        const agent = invocation?.agent;
        const switchPreset = (name2) => {
          const permission = ctx.get("permissionPresets");
          if (permission === void 0 || agent?.session === void 0) {
            return { kind: "error", text: "permission presets are not available in this composition" };
          }
          try {
            permission.set(agent.session, name2);
            return { kind: "success", text: `Pre-edit review: switched file policy to ${name2}` };
          } catch (error) {
            return {
              kind: "error",
              text: `could not switch to ${name2}: ${error instanceof Error ? error.message : String(error)}`
            };
          }
        };
        const setPaused = async (paused) => {
          const session = agent?.session;
          if (session === void 0) {
            return { kind: "error", text: "review pause needs an agent session" };
          }
          if (paused && !config.allowPause) {
            return { kind: "error", text: "review pause is disabled by configuration (allowPause: false)" };
          }
          const was = runtime.pause.isPaused(session);
          runtime.pause.set(session, paused);
          runtime.ipc.notifyMode({ paused: runtime.pause.anyPaused() });
          if (was !== paused) {
            await runtime.store.audit({
              event: paused ? "review/paused" : "review/resumed",
              sessionId: String(session.id ?? "unknown")
            });
          }
          if (paused) {
            return {
              kind: "success",
              text: "Pre-edit review: OFF for this session \u2014 the agent writes files directly, without a review request. The sandbox policy is unchanged (read-only still denies writes). Run /review on to restore review.\n\u5DF2\u6682\u505C\u672C\u4F1A\u8BDD\u7684\u4FEE\u6539\u524D\u5BA1\u9605\uFF1A\u6587\u4EF6\u4FEE\u6539\u5C06\u76F4\u63A5\u6267\u884C\u3001\u4E0D\u518D\u5F39\u51FA\u5BA1\u6279\uFF1B\u6587\u4EF6\u7B56\u7565\u4E0D\u53D8\u3002\u8F93\u5165 /review on \u6062\u590D\u5BA1\u6279\u3002"
            };
          }
          return {
            kind: "success",
            text: "Pre-edit review: ON for this session \u2014 file writes are reviewed again.\n\u6062\u590D\u672C\u4F1A\u8BDD\u7684\u4FEE\u6539\u524D\u5BA1\u9605\uFF1A\u6587\u4EF6\u4FEE\u6539\u91CD\u65B0\u9700\u8981\u5BA1\u6279\u3002"
          };
        };
        if (raw === "on") return await setPaused(false);
        if (raw === "off") return await setPaused(true);
        if (raw === "strict") return switchPreset("read-only");
        if (raw === "balanced") return switchPreset("workspace-write");
        if (raw === "history" || raw.startsWith("history ")) {
          const requested = Number(raw.slice("history".length).trim());
          const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 50) : 10;
          const entries = await readAuditHistory(config.stateDir, limit);
          return { kind: "success", text: formatHistory(entries, limit) };
        }
        if (raw === "" || raw === "status") {
          const status = runtime.coordinator.status();
          const policy = ctx.get("sandboxPolicy");
          let sandboxMode = "unknown";
          try {
            sandboxMode = policy?.resolve({ ...agent?.session !== void 0 ? { session: agent.session } : {} }).mode ?? "unknown";
          } catch {
            sandboxMode = "unknown";
          }
          const strict = sandboxMode === "read-only";
          const paused = runtime.pause.isPaused(agent?.session);
          const lines = [
            `Pre-edit review: ${config.enabled ? "ON" : "OFF"} (mode=${status.mode})`,
            `review client: ${status.connected ? "connected" : "NOT connected"}`,
            `pending reviews: ${status.pending}`,
            `review: ${paused ? "PAUSED for this session \u2014 writes are NOT reviewed (/review on to resume)" : "on (/review off to pause this session)"}`,
            `file policy: ${sandboxMode} ${strict ? "(strict: ALL writes require approval)" : "(tool-level: shell writes are NOT reviewed)"}`,
            `state dir: ${status.stateDir}`,
            `socket: ${status.socketPath}`
          ];
          if (!strict) lines.push("tip: /review strict switches this session to read-only, the only mode that cannot be bypassed.");
          return { kind: "success", text: lines.join("\n") };
        }
        return { kind: "error", text: `unknown /review argument "${raw}" (use status|on|off|strict|balanced|history [n])` };
      }
    });
    logger.info("[pre-edit-review] /review command registered");
  });
}
function installPromptSection(ctx) {
  if (ctx.inject === void 0) return;
  ctx.inject(["systemPrompt"], (sub) => {
    sub.systemPrompt.section({
      name: "pre-edit-review",
      order: 900,
      text: PROMPT_SECTION
    });
  });
}
export {
  PLUGIN_VERSION,
  apply,
  checkHostCapabilities,
  inject,
  name
};
//# sourceMappingURL=index.mjs.map
