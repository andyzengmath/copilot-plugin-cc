import test from "node:test";
import assert from "node:assert/strict";

import { probeModelAvailability } from "../plugins/copilot/scripts/lib/copilot.mjs";
import { buildCopilotEnv, REPO_ROOT } from "./harness.mjs";

test("probeModelAvailability times out a hanging probe with a clear detail", async () => {
  // Simulate a probe that never settles (degraded backend, stuck cold-start).
  // The fake-copilot fixture's hangModels option blocks `-p` mode forever
  // for listed models, exercising the per-probe setTimeout settle path
  // that v0.0.21 tuned (15s → 60s default). Without this lock, a future
  // regression — strip `timer.unref?.()`, drop the kill-on-timeout, or
  // bump the default down again to 15s — could ship silently because
  // setup-probe.test.mjs only exercises the available/unavailable paths.
  const env = buildCopilotEnv({
    script: {
      hangModels: ["hanger-model"]
    }
  });

  const start = Date.now();
  const results = await probeModelAvailability(REPO_ROOT, {
    env,
    models: ["hanger-model", "responsive-model"],
    timeoutMs: 250
  });
  const elapsed = Date.now() - start;

  assert.equal(results.length, 2);

  const hanging = results.find((r) => r.model === "hanger-model");
  assert.equal(hanging.available, false);
  assert.equal(hanging.unknown, true);
  assert.match(hanging.detail, /probe timed out after 250ms/);

  // The non-hanging probe should respond promptly with success. fake-copilot's
  // `-p` mode for unscripted models prints whatever script.prompt.updates
  // produce (empty by default) and exits 0, which probeSingleModel reads as
  // available:true.
  const responsive = results.find((r) => r.model === "responsive-model");
  assert.equal(responsive.available, true);

  // Wall-clock should be bounded by timeoutMs + child-spawn overhead, NOT 2x.
  // Promise.all parallelism is the v0.0.21 wall-clock invariant called out in
  // CHANGELOG 0.0.21 ("Probes still run in parallel via Promise.all, so
  // wall-clock cost of --probe-models is bounded by the slowest probe, not
  // the sum"). 3000ms upper bound gives lots of slack for slow Windows CI
  // cold-spawn without inviting a flaky timeout assertion.
  assert.ok(
    elapsed < 3000,
    `expected wall-clock under 3000ms (parallel probes), got ${elapsed}ms`
  );
});
