import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const environmentPath = resolve(".env");

if (!existsSync(environmentPath)) {
  console.error(
    "A populated, operator-restricted .env file is required. Copy .env.example and replace every placeholder.",
  );
  process.exit(1);
}

function readPublicAppUrl(contents) {
  const assignment = contents
    .split(/\r?\n/u)
    .find((line) => /^\s*(?:export\s+)?NEXT_PUBLIC_APP_URL\s*=/u.test(line));
  const rawValue = assignment
    ? assignment
        .replace(/^\s*(?:export\s+)?NEXT_PUBLIC_APP_URL\s*=\s*/u, "")
        .trim()
    : "http://localhost:3000";
  const value =
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ? rawValue.slice(1, -1)
      : rawValue;

  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("unsupported public URL");
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    console.error("NEXT_PUBLIC_APP_URL in .env must be a valid HTTP(S) URL.");
    process.exit(1);
  }
}

const publicAppUrl = readPublicAppUrl(readFileSync(environmentPath, "utf8"));
const commands = [
  ["compose", "config", "--quiet"],
  ["compose", "up", "--build", "--detach", "--wait", "app", "worker"],
  ["compose", "--profile", "bootstrap", "run", "--rm", "bootstrap-admin"],
];

for (const arguments_ of commands) {
  const result = spawnSync("docker", arguments_, { stdio: "inherit" });
  if (result.error) {
    console.error("Docker Compose could not be started.");
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Sign in: ${publicAppUrl}`);
console.log(
  "AI status: unavailable from the base Compose stack unless an external provider is configured or the Ollama overlay is started.",
);
