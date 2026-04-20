function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

const REVIEW_VERDICT_ENUM = ["approve", "needs-attention"];
const REVIEW_SEVERITY_ENUM = ["critical", "high", "medium", "low"];
const REVIEW_TOP_KEYS = new Set(["verdict", "summary", "findings", "next_steps"]);
const REVIEW_FINDING_KEYS = new Set([
  "severity",
  "title",
  "body",
  "file",
  "line_start",
  "line_end",
  "confidence",
  "recommendation"
]);

function validateReviewFinding(finding, index, errors) {
  const prefix = `findings[${index}]`;
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    errors.push(`${prefix} must be a JSON object.`);
    return;
  }

  for (const key of Object.keys(finding)) {
    if (!REVIEW_FINDING_KEYS.has(key)) {
      errors.push(`${prefix}: unexpected property \`${key}\`.`);
    }
  }

  if (typeof finding.severity !== "string") {
    errors.push(`${prefix}.severity must be a string.`);
  } else if (!REVIEW_SEVERITY_ENUM.includes(finding.severity)) {
    errors.push(
      `${prefix}.severity: ${JSON.stringify(finding.severity)} not in {${REVIEW_SEVERITY_ENUM.join(", ")}}.`
    );
  }

  for (const field of ["title", "body", "file"]) {
    const value = finding[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${prefix}.${field} must be a non-empty string.`);
    }
  }

  for (const field of ["line_start", "line_end"]) {
    const value = finding[field];
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`${prefix}.${field} must be an integer >= 1.`);
    }
  }

  if (
    typeof finding.confidence !== "number" ||
    Number.isNaN(finding.confidence) ||
    finding.confidence < 0 ||
    finding.confidence > 1
  ) {
    errors.push(`${prefix}.confidence must be a number in [0, 1].`);
  }

  if (typeof finding.recommendation !== "string") {
    errors.push(`${prefix}.recommendation must be a string.`);
  }
}

function validateReviewOutput(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("Expected a top-level JSON object.");
    return errors;
  }

  for (const key of Object.keys(data)) {
    if (!REVIEW_TOP_KEYS.has(key)) {
      errors.push(`Unexpected top-level property: \`${key}\`.`);
    }
  }

  if (typeof data.verdict !== "string") {
    errors.push("Missing string `verdict`.");
  } else if (!REVIEW_VERDICT_ENUM.includes(data.verdict)) {
    errors.push(
      `Invalid \`verdict\`: ${JSON.stringify(data.verdict)} not in {${REVIEW_VERDICT_ENUM.join(", ")}}.`
    );
  }

  if (typeof data.summary !== "string" || data.summary.trim().length === 0) {
    errors.push("Missing non-empty string `summary`.");
  }

  if (!Array.isArray(data.findings)) {
    errors.push("Missing array `findings`.");
  } else {
    data.findings.forEach((finding, index) => {
      validateReviewFinding(finding, index, errors);
    });
  }

  if (!Array.isArray(data.next_steps)) {
    errors.push("Missing array `next_steps`.");
  } else {
    data.next_steps.forEach((step, index) => {
      if (typeof step !== "string" || step.trim().length === 0) {
        errors.push(`next_steps[${index}] must be a non-empty string.`);
      }
    });
  }

  return errors;
}

function normalizeReviewFinding(finding) {
  // validateReviewOutput has already guaranteed: severity is an enum
  // string, title / body / file are non-empty strings, line_start and
  // line_end are integers >= 1, confidence is a number in [0, 1], and
  // recommendation is a string. Only trimming remains.
  return {
    severity: finding.severity,
    title: finding.title.trim(),
    body: finding.body.trim(),
    file: finding.file.trim(),
    line_start: finding.line_start,
    line_end: finding.line_end,
    recommendation: finding.recommendation.trim()
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map(normalizeReviewFinding),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCopilotResumeCommand(job) {
  const sessionId =
    job?.result?.copilotSessionId ??
    job?.threadId ??
    null;
  if (!sessionId) {
    return null;
  }
  return `copilot --continue ${sessionId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Copilot Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/copilot:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/copilot:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Copilot session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCopilotResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Copilot: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /copilot:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /copilot:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /copilot:review --wait");
    lines.push("  Stricter review: /copilot:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Copilot Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- copilot: ${report.copilot.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (Array.isArray(report.modelProbe) && report.modelProbe.length > 0) {
    lines.push("Model availability (--probe-models):");
    for (const entry of report.modelProbe) {
      const marker = entry.available ? "ok" : entry.unknown ? "unknown" : "unavailable";
      lines.push(`- ${entry.model}: ${marker} — ${entry.detail}`);
    }
    lines.push("");
  }

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Copilot ${meta.reviewLabel}`,
      "",
      "Copilot did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationErrors = validateReviewOutput(parsedResult.parsed);
  if (validationErrors.length > 0) {
    const lines = [
      `# Copilot ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Copilot returned JSON with an unexpected review shape.",
      "",
      "Schema violations:"
    ];
    for (const violation of validationErrors) {
      lines.push(`- ${violation}`);
    }

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Copilot ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Copilot ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Copilot review completed without any stdout output.");
  } else {
    lines.push("Copilot review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Copilot did not return a final message.";
  return `${message}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Copilot Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Copilot adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Copilot Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `copilot --continue ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCopilot session ID: ${threadId}\nResume in Copilot: ${resumeCommand}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.copilot?.stdout === "string" && storedJob.result.copilot.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCopilot session ID: ${threadId}\nResume in Copilot: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCopilot session ID: ${threadId}\nResume in Copilot: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Copilot Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Copilot session ID: ${threadId}`);
    lines.push(`Resume in Copilot: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Copilot Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/copilot:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
