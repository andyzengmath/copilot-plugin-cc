import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/copilot/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Copilot returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

function renderSchemaFailure(parsed) {
  return renderReviewResult(
    {
      parsed,
      rawOutput: JSON.stringify(parsed),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );
}

test("renderReviewResult rejects verdicts outside the allowed enum", () => {
  const output = renderSchemaFailure({
    verdict: "reject",
    summary: "Looks bad.",
    findings: [],
    next_steps: []
  });

  assert.match(output, /Copilot returned JSON with an unexpected review shape\./);
  assert.match(
    output,
    /`verdict`.*"reject".*approve.*needs-attention/,
    "must name the invalid verdict and list the allowed values"
  );
});

test("renderReviewResult rejects findings with an unknown severity", () => {
  const output = renderSchemaFailure({
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [
      {
        severity: "catastrophic",
        title: "Uh oh",
        body: "Something bad",
        file: "src/foo.ts",
        line_start: 10,
        line_end: 12,
        confidence: 0.9,
        recommendation: "Fix it"
      }
    ],
    next_steps: []
  });

  assert.match(output, /findings\[0\]\.severity.*"catastrophic"/);
  assert.match(output, /critical.*high.*medium.*low/);
});

test("renderReviewResult rejects confidence values outside [0, 1]", () => {
  const output = renderSchemaFailure({
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [
      {
        severity: "high",
        title: "Uh oh",
        body: "Something bad",
        file: "src/foo.ts",
        line_start: 10,
        line_end: 12,
        confidence: 1.5,
        recommendation: "Fix it"
      }
    ],
    next_steps: []
  });

  assert.match(output, /findings\[0\]\.confidence/);
  assert.match(output, /\[0, 1\]/);
});

test("renderReviewResult rejects findings missing required fields", () => {
  const output = renderSchemaFailure({
    verdict: "needs-attention",
    summary: "One issue.",
    findings: [
      {
        severity: "high",
        title: "Only a title"
        // everything else missing
      }
    ],
    next_steps: []
  });

  assert.match(output, /findings\[0\]\.body/);
  assert.match(output, /findings\[0\]\.file/);
  assert.match(output, /findings\[0\]\.line_start/);
  assert.match(output, /findings\[0\]\.line_end/);
  assert.match(output, /findings\[0\]\.confidence/);
  assert.match(output, /findings\[0\]\.recommendation/);
});

test("renderReviewResult rejects empty-string next_steps entries", () => {
  const output = renderSchemaFailure({
    verdict: "approve",
    summary: "All good.",
    findings: [],
    next_steps: ["   ", "real step"]
  });

  assert.match(output, /next_steps\[0\].*non-empty string/);
});

test("renderReviewResult rejects unknown top-level properties", () => {
  const output = renderSchemaFailure({
    verdict: "approve",
    summary: "All good.",
    findings: [],
    next_steps: [],
    bogus_extra: "surprise"
  });

  assert.match(output, /Unexpected top-level property.*bogus_extra/);
});

test("renderReviewResult reports every violation in one pass", () => {
  const output = renderSchemaFailure({
    verdict: "maybe",
    summary: "",
    findings: [
      {
        severity: "info",
        title: "",
        body: "",
        file: "",
        line_start: 0,
        line_end: -1,
        confidence: -0.1,
        recommendation: 42
      }
    ],
    next_steps: [""]
  });

  // Every error should surface; the bulleted list guarantees they're all
  // visible rather than just the first one.
  assert.match(output, /`verdict`/);
  assert.match(output, /`summary`/);
  assert.match(output, /findings\[0\]\.severity/);
  assert.match(output, /findings\[0\]\.title/);
  assert.match(output, /findings\[0\]\.body/);
  assert.match(output, /findings\[0\]\.file/);
  assert.match(output, /findings\[0\]\.line_start/);
  assert.match(output, /findings\[0\]\.line_end/);
  assert.match(output, /findings\[0\]\.confidence/);
  assert.match(output, /findings\[0\]\.recommendation/);
  assert.match(output, /next_steps\[0\]/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Copilot Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Copilot Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Copilot Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Copilot session ID: thr_123/);
  assert.match(output, /Resume in Copilot: copilot --continue thr_123/);
});
