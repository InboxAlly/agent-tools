import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "./errors.js";
import { Placement, type Selector } from "./placement.js";
import { terminal, type PublicTest, type Result } from "./results.js";

export interface WatchClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export const realClock: WatchClock = {
  now: () => performance.now(),
  sleep: async (ms, signal) => { await sleep(ms, undefined, { signal }); },
};
export interface WatchOptions {
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (result: Result) => void;
}
export interface WatchData {
  test: PublicTest;
  watch: { elapsed_seconds: number; timed_out: boolean };
}

// Aborting the fetch alone is insufficient if an adapter stalls before it returns.
// Race the whole read, and require the adapter to obey the signal to release resources.
export async function readStatus(placement: Placement, selector: Selector, timeoutMs = 20000, signal?: AbortSignal): Promise<Result> {
  const controller = new AbortController();
  const interrupted = () => controller.abort(new CliError("INTERRUPTED", "Stopped locally; the remote test remains available.", 130));
  if (signal?.aborted) interrupted();
  signal?.addEventListener("abort", interrupted, { once: true });
  const timer = setTimeout(() => controller.abort(new CliError("REQUEST_TIMEOUT", "The result request timed out.", 6, true)), timeoutMs);
  let abortListener: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    return await Promise.race([placement.status(selector, controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupted);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}

export async function watch(placement: Placement, selector: Selector, options: WatchOptions = {}, clock: WatchClock = realClock): Promise<WatchData> {
  const seconds = options.timeoutSeconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new CliError("INVALID_ARGUMENTS", "Watch timeout must be an integer from 1 to 900 seconds.");
  placement.api.assertAvailable();
  const started = clock.now();
  const deadline = started + seconds * 1000;
  const run = await placement.selected(selector);
  let latest: PublicTest = run.snapshot ?? run.test;
  let failures = 0;
  const data = (timedOut = false): WatchData => ({
    test: latest, watch: { elapsed_seconds: Math.max(0, (clock.now() - started) / 1000), timed_out: timedOut },
  });
  const timeout = (): never => {
    throw new CliError("WATCH_TIMEOUT", "Watch reached its local deadline. Resume this test later; no new test was allocated.", 7, false, data(true));
  };
  const cancelled = (): never => {
    throw new CliError("INTERRUPTED", "Stopped locally; the remote test remains available.", 130, false, data());
  };
  const wait = async (delay: number) => {
    if (options.signal?.aborted) return cancelled();
    const remaining = deadline - clock.now();
    if (remaining <= 0) return timeout();
    try { await clock.sleep(Math.min(delay, remaining), options.signal); }
    catch (error) { if (options.signal?.aborted) return cancelled(); throw error; }
    if (options.signal?.aborted) return cancelled();
    if (clock.now() >= deadline) return timeout();
  };

  for (;;) {
    if (options.signal?.aborted) return cancelled();
    const remaining = deadline - clock.now();
    if (remaining <= 0) return timeout();
    let result: Result;
    try {
      result = await readStatus(placement, selector, Math.min(20000, remaining), options.signal);
    } catch (error) {
      if (options.signal?.aborted) return cancelled();
      if (clock.now() >= deadline) return timeout();
      const e = error instanceof CliError ? error : new CliError("INTERNAL_ERROR", "The result request failed unexpectedly.", 1);
      failures++;
      const transient = e.retryable && ["REQUEST_TIMEOUT", "SERVICE_UNAVAILABLE", "NETWORK_ERROR", "RATE_LIMITED"].includes(e.code);
      if (!transient || failures >= 3) throw new CliError(e.code, e.message, e.exitCode, e.retryable, data(), e.details);
      const retry = e.details.retry_after_seconds;
      if (retry !== undefined && (!Number.isFinite(retry) || retry < 0)) throw new CliError("INVALID_RESULTS", "The server returned an invalid retry delay.", 5, false, data());
      await wait(Math.max(15000, latest.poll_after_seconds * 1000, (retry ?? 0) * 1000, 1000 * 2 ** (failures - 1) * (1 + Math.random())));
      continue;
    }
    latest = result;
    failures = 0;
    options.onProgress?.(result);
    if (terminal(result)) {
      if (result.status !== "complete" || result.validation.status === "invalid") {
        throw new CliError("MEASUREMENT_UNUSABLE", "The measurement is " + result.status + " with validity " + result.validation.status + ".", 8, false, data());
      }
      return data();
    }
    await wait(Math.max(15, result.poll_after_seconds) * 1000);
  }
}
