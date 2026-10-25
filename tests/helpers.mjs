import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
export const aiEntry = import.meta.resolve("@earendil-works/pi-ai");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    typebox: fileURLToPath(import.meta.resolve("typebox")),
    "@earendil-works/pi-tui": fileURLToPath(
      import.meta.resolve("@earendil-works/pi-tui"),
    ),
  },
});
export const stateModule = await jiti.import(join(root, "src/state.ts"));
export const { runCheck } = await jiti.import(join(root, "src/verify.ts"));
export const runtimeModule = await jiti.import(join(root, "src/runtime.ts"));
export const { probeWait } = await jiti.import(join(root, "src/wait.ts"));
export const operationsModule = await jiti.import(
  join(root, "src/operations.ts"),
);
const { default: extension } = await jiti.import(join(root, "src/index.ts"));
export const definition = (overrides = {}) => ({
  goal: "Create a small tested feature",
  acceptance: ["Feature works"],
  constraints: ["Do not deploy"],
  checks: ["printf verified"],
  limits: {
    maxMinutes: 1,
    maxContinuations: 4,
    maxTurns: 20,
    maxConsecutiveNoProgress: 3,
    checkTimeoutSeconds: 1,
  },
  ...overrides,
});

export async function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mission-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const hooks = new Map(),
    tools = new Map(),
    commands = new Map();
  const entries = structuredClone(options.entries || []),
    messages = [],
    prompts = [],
    notifications = [];
  let active = ["read", "bash", "edit", "write"],
    idle = true,
    aborts = 0;
  let terminalHandler;
  const operation = new AbortController();
  const ctx = {
    cwd: options.cwd || dir,
    hasUI: false,
    mode: options.mode || "json",
    signal: operation.signal,
    sessionManager: { getBranch: () => entries },
    isIdle: () => idle,
    abort() {
      aborts++;
      operation.abort();
    },
    ui: {
      setStatus() {},
      notify: (...args) => notifications.push(args),
      confirm: async () => true,
      onTerminalInput(handler) {
        terminalHandler = handler;
        return () => {
          terminalHandler = undefined;
        };
      },
    },
  };
  const api = {
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    setActiveTools: (names) => {
      active = names;
    },
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendUserMessage: (prompt) => prompts.push(prompt),
    sendMessage: (msg, delivery) => {
      options.onSendMessage?.(msg, delivery, entries);
      messages.push(msg);
    },
  };
  extension(api);
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of hooks.get(name) || []) {
      const next = await handler({ type: name, ...event }, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  await emit("session_start");
  t.after(async () => {
    await emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const latest = () =>
    structuredClone(
      entries.filter((e) => e.customType === "mission-state-v1").at(-1)?.data,
    );
  const command = (args) => commands.get("mission").handler(args, ctx);
  return {
    dir,
    ctx,
    entries,
    messages,
    prompts,
    notifications,
    emit,
    latest,
    command,
    terminal(data) {
      return terminalHandler?.(data);
    },
    get aborts() {
      return aborts;
    },
    get active() {
      return active;
    },
    setIdle(value) {
      idle = value;
    },
    async start(mission = definition()) {
      const file = join(dir, "mission.json");
      writeFileSync(file, JSON.stringify(mission));
      await command(`start --yes ${file}`);
      await emit("before_agent_start", {
        systemPromptOptions: { sections: {} },
      });
      return file;
    },
    operation(params) {
      return tools
        .get("mission_operation")
        .execute("operation", params, ctx.signal, undefined, ctx);
    },
    wait(params, mode = "rpc") {
      ctx.mode = mode;
      return tools
        .get("mission_wait")
        .execute("wait", params, ctx.signal, undefined, ctx);
    },
    report(
      params = {
        status: "complete",
        summary: "Implemented and tested",
        evidence: [
          { criterion: 1, evidence: "Feature test covers the implementation" },
        ],
      },
    ) {
      return tools
        .get("mission_report")
        .execute("report", params, ctx.signal, undefined, ctx);
    },
    settle(overrides = {}) {
      return emit("agent_before_settle", {
        entries: [],
        continue: false,
        context: { canContinue: false },
        outcome: "completed",
        ...overrides,
      });
    },
  };
}
