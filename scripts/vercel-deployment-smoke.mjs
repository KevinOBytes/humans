#!/usr/bin/env node

import { parseSmokeConfig, runSmoke } from "./vercel-deployment-smoke-lib.mjs";

let config;
try {
  config = parseSmokeConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!config) {
  process.stdout.write(
    "Vercel smoke skipped: set VERCEL_SMOKE_URL (or VERCEL_URL) to a deployed URL.\n",
  );
  process.exit(0);
}

runSmoke(config)
  .then(() => {
    process.stdout.write(`Vercel smoke passed for ${config.base.toString()}\n`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
