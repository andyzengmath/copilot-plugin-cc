import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { CopilotAcpClient, COPILOT_COMMAND_ENV } from "../plugins/copilot/scripts/lib/acp-client.mjs";

const FAKE_COPILOT = fileURLToPath(new URL("./fake-copilot.mjs", import.meta.url));

function envFor(script) {
  return {
    ...process.env,
    [COPILOT_COMMAND_ENV]: JSON.stringify(["node", FAKE_COPILOT]),
    FAKE_COPILOT_SCRIPT: script ? JSON.stringify(script) : ""
  };
}

test("fake-copilot responds to initialize with configurable capabilities", async () => {
  const env = envFor({
    initialize: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true }
      },
      agentInfo: { name: "fake-copilot-smoke", version: "9.9.9" },
      authMethods: []
    }
  });

  // Drive the direct (non-broker) client so we avoid filesystem broker state.
  const client = await CopilotAcpClient.connect(process.cwd(), {
    env,
    disableBroker: true
  });
  try {
    // Re-initialize path is not exposed; reaching this point means the handshake completed.
    assert.equal(client.transport, "direct");
  } finally {
    await client.close();
  }
});

test("session/new returns the scripted sessionId; session/prompt emits updates + stopReason", async () => {
  const scriptedUpdates = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }
  ];
  const env = envFor({
    sessionId: "sess-smoke-1",
    prompt: {
      updates: scriptedUpdates,
      stopReason: "end_turn"
    }
  });

  const client = await CopilotAcpClient.connect(process.cwd(), { env, disableBroker: true });
  const collected = [];
  client.setNotificationHandler((msg) => {
    if (msg.method === "session/update") {
      collected.push(msg.params);
    }
  });

  try {
    const newResp = await client.request("session/new", {
      cwd: path.resolve(process.cwd()),
      mcpServers: []
    });
    assert.equal(newResp.sessionId, "sess-smoke-1");

    const promptResp = await client.request("session/prompt", {
      sessionId: newResp.sessionId,
      prompt: [{ type: "text", text: "hi" }]
    });
    assert.equal(promptResp.stopReason, "end_turn");

    // Give any in-flight notifications a tick to settle.
    await new Promise((r) => setImmediate(r));

    const texts = collected
      .map((p) => p.update?.content?.text)
      .filter((t) => typeof t === "string");
    assert.deepEqual(texts, ["Hello ", "world"]);
    assert.equal(collected[0].sessionId, "sess-smoke-1");
  } finally {
    await client.close();
  }
});

test("session/prompt error response is propagated as a rejection on the client", async () => {
  const env = envFor({
    sessionId: "sess-err-1",
    prompt: { error: { code: -32099, message: "fake transport hiccup" } }
  });

  const client = await CopilotAcpClient.connect(process.cwd(), { env, disableBroker: true });
  try {
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    await assert.rejects(
      () =>
        client.request("session/prompt", {
          sessionId: "sess-err-1",
          prompt: [{ type: "text", text: "hi" }]
        }),
      (err) => /fake transport hiccup/.test(String(err?.message ?? err))
    );
  } finally {
    await client.close();
  }
});

test("session/cancel is accepted by default", async () => {
  const env = envFor({ sessionId: "sess-cancel-1" });
  const client = await CopilotAcpClient.connect(process.cwd(), { env, disableBroker: true });
  try {
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const resp = await client.request("session/cancel", { sessionId: "sess-cancel-1" });
    assert.deepEqual(resp, {});
  } finally {
    await client.close();
  }
});

test("session/prompt can drive a server-initiated session/request_permission turnaround", async () => {
  const env = envFor({
    sessionId: "sess-perm-1",
    prompt: {
      permissionRequest: {
        toolCall: { toolCallId: "t-1", title: "delete world", kind: "shell" },
        options: [
          { optionId: "allow_once_id", kind: "allow_once", name: "Allow once" },
          { optionId: "reject_once_id", kind: "reject_once", name: "Reject" }
        ]
      },
      stopReason: "end_turn"
    }
  });

  const client = await CopilotAcpClient.connect(process.cwd(), { env, disableBroker: true });
  try {
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    // The base client auto-approves with allow_once (per firstAllowOption) —
    // verified here by the prompt completing rather than hanging.
    const resp = await client.request("session/prompt", {
      sessionId: "sess-perm-1",
      prompt: [{ type: "text", text: "do it" }]
    });
    assert.equal(resp.stopReason, "end_turn");
  } finally {
    await client.close();
  }
});
