import { spawn as defaultSpawn } from "node:child_process";

function commandError(command, result) {
  return new Error(
    `${command} exited ${result.code ?? result.signal ?? "unknown"}: ${result.stderr.toString("utf8").slice(-2_000)}`,
  );
}

export function createTrackedCommandExecutor(input) {
  const spawn = input.spawn ?? defaultSpawn;
  const active = new Set();

  async function execute(command, arguments_, options = {}) {
    const child = spawn(command, arguments_, {
      cwd: input.cwd,
      env: input.environment,
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        options.capture ? "pipe" : "inherit",
        options.capture ? "pipe" : "inherit",
      ],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));

    let finish;
    const settled = new Promise((resolve, reject) => {
      let done = false;
      finish = (error, code = null, signal = null) => {
        if (done) return;
        done = true;
        const result = {
          code,
          signal,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout),
        };
        if (error) reject(error);
        else if (code !== 0 && !options.allowFailure)
          reject(commandError(command, result));
        else resolve(result);
      };
    });
    const record = { child, settled };
    active.add(record);
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(undefined, code, signal));
    if (options.input !== undefined) child.stdin?.end(options.input);
    try {
      return await settled;
    } finally {
      active.delete(record);
    }
  }

  async function stopActive() {
    const records = [...active];
    for (const record of records) record.child.kill("SIGTERM");
    await Promise.allSettled(records.map((record) => record.settled));
  }

  return { execute, stopActive };
}

export function createTeardownCoordinator(input) {
  let shutdownPromise;

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const errors = [];
      try {
        await input.stopActive();
      } catch (error) {
        errors.push(error);
      }
      for (const step of input.cleanupSteps) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Compose lifecycle teardown failed");
      }
    })();
    return shutdownPromise;
  }

  return { shutdown };
}

export async function assertComposeResourcesRemoved(input) {
  const label = `label=com.docker.compose.project=${input.project}`;
  const checks = [
    ["ps", "--all", "--quiet", "--filter", label],
    ["volume", "ls", "--quiet", "--filter", label],
    ["network", "ls", "--quiet", "--filter", label],
  ];
  const remaining = [];
  for (const arguments_ of checks) {
    const result = await input.execute("docker", arguments_, { capture: true });
    const names = result.stdout.toString("utf8").trim();
    if (names) remaining.push(`${arguments_[0]}: ${names}`);
  }
  const image = await input.execute(
    "docker",
    ["image", "inspect", input.image],
    { allowFailure: true, capture: true },
  );
  if (image.code === 0) remaining.push(`image: ${input.image}`);
  if (remaining.length > 0) {
    throw new Error(
      `Compose resources remain after teardown (${remaining.join("; ")})`,
    );
  }
}

export function assertDirectNodeChildOfComposeInit(input) {
  const initPid = String(input.initPid).trim();
  if (!/^\d+$/u.test(initPid)) {
    throw new Error("Compose container PID 1 host identity is invalid");
  }
  const rows = String(input.processTable)
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [pid, ppid, command, ...arguments_] = line.trim().split(/\s+/u);
      return { arguments: arguments_.join(" "), command, pid, ppid };
    });
  const init = rows.find(
    (row) =>
      row.pid === initPid &&
      (row.command === "docker-init" || row.arguments.includes("docker-init")),
  );
  if (!init) {
    throw new Error("Compose init is not the container PID 1 process");
  }
  if (input.runtimePath !== "/nodejs/bin/node") {
    throw new Error("Compose runtime path is not direct Distroless Node");
  }
  if (!input.runtimeArguments.includes(input.expectedArgument)) {
    throw new Error("Compose runtime arguments do not match the service");
  }
  const node = rows.find(
    (row) =>
      row.ppid === init.pid &&
      (row.command === "node" ||
        row.command === "MainThread" ||
        row.arguments.includes("/nodejs/bin/node") ||
        row.arguments.includes("next-server")),
  );
  if (!node) {
    throw new Error("Runtime Node is not the direct child of Compose init");
  }
  if (
    /\b(?:sh|bash|pnpm|npm|npx|tsx)\b/u.test(
      `${input.runtimePath} ${input.runtimeArguments.join(" ")} ${node.arguments}`,
    )
  ) {
    throw new Error("Runtime Node process contains a forbidden wrapper");
  }
}
