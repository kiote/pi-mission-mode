import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piEntry, aiEntry, root, definition } from "./helpers.mjs";

// Actual AgentSession + extension loader + boundary processing; only model output is fake.
for (const externalWait of [false, true]) {
  test(
    externalWait
      ? "real Pi loop yields, wakes automatically from an external file, verifies, and settles"
      : "real Pi loop continues a premature stop, executes mission_report, verifies, and settles",
    { timeout: 15000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-mission-integration-"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
      const previousOffline = process.env.PI_OFFLINE;
      process.env.PI_OFFLINE = "1";
      const {
        createAgentSession,
        DefaultResourceLoader,
        ModelRuntime,
        SessionManager,
        SettingsManager,
      } = await import(piEntry);
      const { createAssistantMessageEventStream } = await import(aiEntry);
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const model =
        runtime
          .getModels("openai")
          .find((m) => m.api === "openai-completions") ||
        runtime.getModels("openai")[0];
      assert.ok(model, "A static OpenAI model exists for the offline test");
      await runtime.setRuntimeApiKey(model.provider, "fake-key-never-sent");
      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: join(dir, "agent"),
        settingsManager,
        noExtensions: true,
        additionalExtensionPaths: [root],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(dir);
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: join(dir, "agent"),
        modelRuntime: runtime,
        model,
        resourceLoader: loader,
        settingsManager,
        sessionManager: manager,
      });
      const extensionErrors = [];
      await session.bindExtensions({
        mode: externalWait ? "rpc" : "json",
        onError: (error) => extensionErrors.push(error),
      });
      t.after(async () => {
        await session.abort();
        session.dispose();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
        rmSync(dir, { recursive: true, force: true });
      });
      let requests = 0;
      let feedbackSeen = false;
      runtime.streamSimple = () => {
        throw new Error("Provider access is forbidden in this offline test");
      };
      session.agent.streamFunction = (_model, context) => {
        requests++;
        if (
          context.messages.some((m) =>
            /Completion gate:|External event ready/.test(JSON.stringify(m)),
          )
        )
          feedbackSeen = true;
        if (requests > (externalWait ? 4 : 3))
          throw new Error("Unexpected extra model request");
        const reportTurn = externalWait ? 3 : 2;
        const toolTurn =
          requests === reportTurn || (externalWait && requests === 1);
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: toolTurn ? "toolUse" : "stop",
          content:
            externalWait && requests === 1
              ? [
                  {
                    type: "toolCall",
                    id: "wait-1",
                    name: "mission_wait",
                    arguments: {
                      conditionId: "external-file",
                      input: { job: "fake-external-job" },
                      summary:
                        "Wait for the fake external job, then inspect its result",
                    },
                  },
                ]
              : requests === reportTurn
                ? [
                    {
                      type: "toolCall",
                      id: "report-1",
                      name: "mission_report",
                      arguments: {
                        status: "complete",
                        summary: "Completed the offline test mission",
                        evidence: [
                          {
                            criterion: 1,
                            evidence:
                              "Fake model supplies evidence; shell check is executed by the extension",
                          },
                        ],
                      },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text:
                        requests === 1
                          ? "Here is my plan. I stopped too early."
                          : "Implementation complete.",
                    },
                  ],
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        });
        return stream;
      };
      const file = join(dir, "mission.json");
      writeFileSync(
        file,
        JSON.stringify(
          definition(
            externalWait
              ? {
                  progressFile: "progress/PROGRESS.md",
                  waiters: [
                    {
                      id: "external-file",
                      kind: "file",
                      path: "ready.json",
                      jsonPath: "done",
                      equals: true,
                      intervalSeconds: 1,
                    },
                  ],
                }
              : {},
          ),
        ),
      );
      let watchdog;
      const settled = new Promise((resolve, reject) => {
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_settled") {
            const state = manager
              .getBranch()
              .filter(
                (e) =>
                  e.type === "custom" && e.customType === "mission-state-v1",
              )
              .at(-1)?.data;
            if (externalWait && state?.status === "waiting") {
              assert.equal(
                requests,
                2,
                "The fake model stops during the external wait",
              );
              setTimeout(
                () =>
                  writeFileSync(
                    join(dir, "ready.json"),
                    JSON.stringify({ done: true }),
                  ),
                100,
              );
              return;
            }
            unsubscribe();
            clearTimeout(watchdog);
            resolve();
          }
        });
        watchdog = setTimeout(() => {
          unsubscribe();
          reject(new Error("Real Pi run did not settle"));
        }, 8000);
      });
      t.after(() => clearTimeout(watchdog));
      await session.prompt(`/mission start --yes ${file}`);
      await settled;
      const saved = manager
        .getBranch()
        .filter(
          (e) => e.type === "custom" && e.customType === "mission-state-v1",
        )
        .at(-1).data;
      assert.deepEqual(extensionErrors, []);
      assert.equal(requests, externalWait ? 4 : 3);
      assert.equal(feedbackSeen, true);
      assert.equal(saved.status, "completed");
      assert.equal(saved.continuations, 1);
      assert.equal(saved.turns, externalWait ? 4 : 3);
      assert.equal(saved.checks[0].output, "verified");
      assert.equal(
        session.getActiveToolNames().includes("mission_report"),
        false,
      );
      if (externalWait) {
        assert.equal(saved.wait, undefined);
        assert.equal(
          saved.digests.filter((d) => d.kind === "event-ready").length,
          1,
        );
        assert.match(
          readFileSync(join(dir, "progress/PROGRESS.md"), "utf8"),
          /completed/,
        );
      }
    },
  );
}
