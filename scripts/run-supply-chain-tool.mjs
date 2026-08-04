#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const [mode, ...rawArguments] = process.argv.slice(2);
if (rawArguments[0] === "--") rawArguments.shift();
const [image = "humans:local", output = "sbom.spdx.json"] = rawArguments;

const commands = {
  sbom: ["syft", [image, "--output", `spdx-json=${output}`]],
  image: [
    "trivy",
    [
      "image",
      "--exit-code",
      "1",
      "--ignore-unfixed=false",
      "--severity",
      "HIGH,CRITICAL",
      image,
    ],
  ],
};

if (mode !== "secrets" && !Object.hasOwn(commands, mode)) {
  process.stderr.write(
    "Usage: run-supply-chain-tool.mjs secrets|sbom|image [image] [sbom-output]\n",
  );
  process.exit(2);
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (result.error?.code === "ENOENT") {
    process.stderr.write(
      `${command} is required locally; install the official CLI before running this gate.\n`,
    );
    return 127;
  }
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (mode === "secrets") {
  const historyStatus = run("gitleaks", [
    "git",
    "--redact",
    "--no-banner",
    "--verbose",
  ]);
  if (historyStatus !== 0) process.exit(historyStatus);
  process.exit(
    run("gitleaks", [
      "git",
      "--staged",
      "--redact",
      "--no-banner",
      "--verbose",
    ]),
  );
}

const [command, arguments_] = commands[mode];
process.exit(run(command, arguments_));
