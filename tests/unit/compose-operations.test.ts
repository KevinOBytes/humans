import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  assertDirectNodeChildOfComposeInit,
  assertComposeResourcesRemoved,
  createTeardownCoordinator,
  createTrackedCommandExecutor,
} from "../../scripts/compose-lifecycle-control.mjs";

describe("isolated Compose operations contract", () => {
  it("requires Compose init as PID 1 and Node as its direct child", () => {
    const processTable = [
      "PID PPID COMMAND COMMAND",
      "4120 4000 docker-init /sbin/docker-init -- /nodejs/bin/node --conditions=react-server runtime/worker.mjs",
      "4133 4120 node /nodejs/bin/node --conditions=react-server runtime/worker.mjs",
    ].join("\n");
    expect(() =>
      assertDirectNodeChildOfComposeInit({
        expectedArgument: "runtime/worker.mjs",
        initPid: "4120\n",
        processTable,
        runtimeArguments: ["--conditions=react-server", "runtime/worker.mjs"],
        runtimePath: "/nodejs/bin/node",
      }),
    ).not.toThrow();
    expect(() =>
      assertDirectNodeChildOfComposeInit({
        expectedArgument: "runtime/worker.mjs",
        initPid: "4120",
        processTable: processTable.replace("4133 4120", "4133 4119"),
        runtimeArguments: ["runtime/worker.mjs"],
        runtimePath: "/nodejs/bin/node",
      }),
    ).toThrow(/direct child/i);
    expect(() =>
      assertDirectNodeChildOfComposeInit({
        expectedArgument: "runtime/worker.mjs",
        initPid: "4121",
        processTable,
        runtimeArguments: ["runtime/worker.mjs"],
        runtimePath: "/nodejs/bin/node",
      }),
    ).toThrow(/PID 1/i);
  });

  it("stops and awaits the active command before running cleanup exactly once", async () => {
    const events: string[] = [];
    let settleActive!: () => void;
    const activeSettled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const coordinator = createTeardownCoordinator({
      stopActive: async () => {
        events.push("stop");
        await activeSettled;
        events.push("settled");
      },
      cleanupSteps: [
        async () => void events.push("down"),
        async () => void events.push("image"),
        async () => void events.push("verify"),
      ],
    });

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    await Promise.resolve();
    expect(events).toEqual(["stop"]);

    settleActive();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(events).toEqual(["stop", "settled", "down", "image", "verify"]);
  });

  it("signals and awaits every tracked child before teardown starts", async () => {
    const events: string[] = [];
    const children: EventEmitter[] = [];
    const runner = createTrackedCommandExecutor({
      cwd: "/tmp",
      environment: {},
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & {
          kill(signal: string): void;
          stderr: null;
          stdin: null;
          stdout: null;
        };
        child.stderr = null;
        child.stdin = null;
        child.stdout = null;
        child.kill = (signal) => {
          events.push(`kill:${signal}`);
          queueMicrotask(() => {
            events.push("closed");
            child.emit("close", null, signal);
          });
        };
        children.push(child);
        return child;
      },
    });
    const commands = Promise.all([
      runner.execute("docker", ["logs"]),
      runner.execute("docker", ["history"]),
    ]);
    const coordinator = createTeardownCoordinator({
      stopActive: runner.stopActive,
      cleanupSteps: [async () => void events.push("cleanup")],
    });

    await coordinator.shutdown();
    await expect(commands).rejects.toThrow();
    expect(children).toHaveLength(2);
    expect(events).toEqual([
      "kill:SIGTERM",
      "kill:SIGTERM",
      "closed",
      "closed",
      "cleanup",
    ]);
  });

  it("attempts every cleanup step and propagates all teardown failures", async () => {
    const events: string[] = [];
    const coordinator = createTeardownCoordinator({
      stopActive: async () => void events.push("stop"),
      cleanupSteps: [
        async () => {
          events.push("down");
          throw new Error("down failed");
        },
        async () => {
          events.push("image");
          throw new Error("image failed");
        },
        async () => void events.push("verify"),
      ],
    });

    const result = coordinator.shutdown();
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(events).toEqual(["stop", "down", "image", "verify"]);
  });

  it("verifies exact project-labelled resources and the exact image are absent", async () => {
    const execute = vi.fn(async (_command: string, arguments_: string[]) => ({
      code: arguments_[0] === "image" ? 1 : 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    }));

    await expect(
      assertComposeResourcesRemoved({
        execute,
        image: "humans-task15b:exact",
        project: "humans-task15b-exact",
      }),
    ).resolves.toBeUndefined();

    expect(execute.mock.calls).toEqual([
      [
        "docker",
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          "label=com.docker.compose.project=humans-task15b-exact",
        ],
        { capture: true },
      ],
      [
        "docker",
        [
          "volume",
          "ls",
          "--quiet",
          "--filter",
          "label=com.docker.compose.project=humans-task15b-exact",
        ],
        { capture: true },
      ],
      [
        "docker",
        [
          "network",
          "ls",
          "--quiet",
          "--filter",
          "label=com.docker.compose.project=humans-task15b-exact",
        ],
        { capture: true },
      ],
      [
        "docker",
        ["image", "inspect", "humans-task15b:exact"],
        {
          allowFailure: true,
          capture: true,
        },
      ],
    ]);
  });

  it("provides one isolated lifecycle runner", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

    expect(scripts["test:compose:smoke"]).toContain(
      "compose-lifecycle.mjs smoke",
    );
    expect(scripts["test:compose:lifecycle"]).toContain(
      "compose-lifecycle.mjs lifecycle",
    );
  });

  it("documents production-provider and recovery boundaries", () => {
    const operations = readFileSync("docs/operations/docker.md", "utf8");

    expect(operations).toContain("RPO: TBD");
    expect(operations).toContain("RTO: TBD");
    expect(operations).toContain("Region: TBD");
    expect(operations).toContain("Alert owner: TBD");
    expect(operations).toContain("R2 or AWS S3");
    expect(operations).toMatch(/clean\s+Redis volume/u);
    expect(operations).toContain("docker-compose.console.yml");
    expect(operations).toContain("same image");
    expect(operations).toContain("digest");
  });
});
