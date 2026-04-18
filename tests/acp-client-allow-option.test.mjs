import test from "node:test";
import assert from "node:assert/strict";

import { firstAllowOption } from "../plugins/copilot/scripts/lib/acp-client.mjs";

test("firstAllowOption returns null for an empty array", () => {
  assert.equal(firstAllowOption([]), null);
});

test("firstAllowOption returns null for a non-array input", () => {
  assert.equal(firstAllowOption(null), null);
  assert.equal(firstAllowOption(undefined), null);
});

test("firstAllowOption prefers allow_once even when allow_always comes first", () => {
  const picked = firstAllowOption([
    { optionId: "a", kind: "allow_always" },
    { optionId: "b", kind: "allow_once" }
  ]);
  assert.equal(picked?.optionId, "b");
});

test("firstAllowOption never returns an allow_always-only list", () => {
  assert.equal(
    firstAllowOption([{ optionId: "a", kind: "allow_always" }]),
    null
  );
});

test("firstAllowOption safe-fallback picks a kindless option when no allow_once exists", () => {
  const picked = firstAllowOption([{ optionId: "x" }]);
  assert.equal(picked?.optionId, "x");
});

test("firstAllowOption returns null when only reject options are present", () => {
  assert.equal(
    firstAllowOption([
      { optionId: "r1", kind: "reject_once" },
      { optionId: "r2", kind: "reject_always" }
    ]),
    null
  );
});

test("firstAllowOption skips allow_always in mixed-kind fallback", () => {
  const picked = firstAllowOption([
    { optionId: "a", kind: "allow_always" },
    { optionId: "b", kind: "reject_once" }
  ]);
  assert.equal(picked, null);
});
