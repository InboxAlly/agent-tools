#!/usr/bin/env node
import { defaultContext, runCli } from "./cli.js";

const context = defaultContext();
const controller = new AbortController();
const interrupt = () => controller.abort();
// Commands that wait on the service stop cleanly on an interrupt, releasing their locks.
const interruptible = process.argv[2] === "placement" && ["create", "status", "watch"].includes(process.argv[3] ?? "");
if (interruptible) {
  context.signal = controller.signal;
  process.on("SIGINT", interrupt);
}
try {
  process.exitCode = await runCli(process.argv.slice(2), context);
} finally {
  if (interruptible) process.removeListener("SIGINT", interrupt);
}
