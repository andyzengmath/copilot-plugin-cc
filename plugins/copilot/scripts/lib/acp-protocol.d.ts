/**
 * Minimal Agent Client Protocol v1 (ACP) type surface that copilot-plugin-cc
 * relies on. Only the shapes we actually consume are declared — the protocol
 * itself is larger, but we intentionally keep the surface tight so we can
 * update this file as Copilot's ACP surface evolves.
 *
 * Source: https://agentclientprotocol.com/
 */

export type ProtocolVersion = 1;

export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface FileSystemCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface ClientCapabilities {
  fs?: FileSystemCapabilities;
  terminal?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: Record<string, unknown>;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: ClientInfo;
}

export interface InitializeResponse {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name: string; title?: string; version?: string };
  authMethods?: AuthMethod[];
}

export interface AuthenticateParams {
  methodId: string;
}

export interface AuthenticateResponse {
  [key: string]: unknown;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface SessionNewParams {
  cwd: string;
  mcpServers?: McpServerConfig[];
}

export interface SessionNewResponse {
  sessionId: string;
  modes?: { current: string; available: Array<{ id: string; name: string }> };
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | {
      type: "resource_link";
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
    }
  | {
      type: "resource";
      resource: { uri: string; text?: string; mimeType?: string };
    };

export interface SessionPromptParams {
  sessionId: string;
  prompt: PromptBlock[];
}

export type StopReason =
  | "end_turn"
  | "cancelled"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal";

export interface SessionPromptResponse {
  stopReason: StopReason;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionCancelResponse {
  [key: string]: unknown;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

export interface ToolCallInfo {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ContentBlock[];
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCallInfo)
  | ({ sessionUpdate: "tool_call_update" } & Partial<ToolCallInfo>)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | {
      sessionUpdate: "commands_available_update";
      availableCommands: Array<{ name: string; description?: string }>;
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: ToolCallInfo;
  options: PermissionOption[];
}

export interface PermissionRequestResponse {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

export interface AcpClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  clientCapabilities?: ClientCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
  reuseExistingBroker?: boolean;
  model?: string | null;
}

export interface AcpMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  authenticate: { params: AuthenticateParams; result: AuthenticateResponse };
  "session/new": { params: SessionNewParams; result: SessionNewResponse };
  "session/prompt": { params: SessionPromptParams; result: SessionPromptResponse };
  "session/cancel": { params: SessionCancelParams; result: SessionCancelResponse };
}

export type AcpMethod = keyof AcpMethodMap;
export type AcpRequestParams<M extends AcpMethod> = AcpMethodMap[M]["params"];
export type AcpResponse<M extends AcpMethod> = AcpMethodMap[M]["result"];
export type AcpNotification = { method: "session/update"; params: SessionUpdateNotification };
export type AcpNotificationHandler = (message: AcpNotification) => void;
