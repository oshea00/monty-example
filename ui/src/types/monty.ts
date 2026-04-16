// SSE events emitted by the Python FastAPI backend

export type SSEStepStart = {
  type: "step_start";
  name: string;
  callId: string;
  input: Record<string, unknown>;
};

export type SSEStepComplete = {
  type: "step_complete";
  name: string;
  callId: string;
  output: unknown;
};

export type SSETextDelta = {
  type: "text_delta";
  text: string;
};

export type SSEDone = { type: "done" };

export type SSEError = { type: "error"; message: string };

export type SSEEvent =
  | SSEStepStart
  | SSEStepComplete
  | SSETextDelta
  | SSEDone
  | SSEError;

// ---- AgentTrace-compatible parts format ----
// These shapes mirror the AI SDK v6 part format that useAgentSteps.ts expects.

export type TextPart = {
  type: "text";
  text: string;
};

export type ToolPart = {
  // Must be "tool-{stepName}" — useAgentSteps checks startsWith("tool-") and strips prefix
  type: string;
  toolCallId: string;
  input: Record<string, unknown>;
  // "input-available" = running, "output-available" = complete, "output-error" = error
  state: "input-available" | "output-available" | "output-error";
  output?: unknown;
};

export type MessagePart = TextPart | ToolPart;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
};

export type ChatStatus = "idle" | "submitted" | "streaming" | "error";
