// agenttrace-ui/useAgentSteps.ts
//
// THE ADAPTER — This is the bridge between the AI SDK and your component.
//
// It takes the raw message.parts array from AI SDK v6 and produces
// the AgentStep[] array that AgentTaskView renders.
//
// Why this exists as a separate hook:
// 1. Separation of concerns — the component does not need to know
//    about AI SDK internals. It just receives AgentStep[].
// 2. Portability — if someone uses LangChain instead of AI SDK,
//    they write a different adapter but use the same component.
// 3. Testability — you can unit test the transformation logic
//    without rendering any UI.

import { useMemo } from "react";

// === TYPES ===

export type AgentStep = {
  stepNumber: number;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  status: "running" | "complete" | "error";
  result?: unknown;
  summary?: string;
  reasoning?: string;
  startedAt?: number;
  completedAt?: number;
};

export type StepFormatter = {
  summary: (args: Record<string, unknown>, result?: unknown) => string;
  reasoning?: (args: Record<string, unknown>, result?: unknown) => string;
};

// === HELPERS ===

function humanize(toolName: string): string {
  const spaced = toolName.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 3) + "...";
}

export function getSummary(
  step: AgentStep,
  formatters?: Record<string, StepFormatter>
): string {
  if (step.summary) return step.summary;
  if (formatters?.[step.toolName]?.summary) {
    return formatters[step.toolName].summary(step.args, step.result);
  }
  const vals = Object.values(step.args);
  if (vals.length > 0 && vals[0] !== undefined) {
    return `${humanize(step.toolName)}: ${truncate(String(vals[0]), 60)}`;
  }
  return humanize(step.toolName);
}

export function getReasoning(
  step: AgentStep,
  formatters?: Record<string, StepFormatter>
): string | null {
  if (step.reasoning) return step.reasoning;
  if (formatters?.[step.toolName]?.reasoning) {
    return formatters[step.toolName].reasoning!(step.args, step.result);
  }
  return null;
}

// === MAP AI SDK v6 STATE ===

function mapStatus(state: string): "running" | "complete" | "error" {
  if (state === "output-available") return "complete";
  if (state === "output-error") return "error";
  return "running"; // input-available, input-streaming, approval-requested
}

// === THE ADAPTER ===
//
// This function walks through the parts array of an assistant message
// and extracts two things:
//
// 1. Tool parts → become AgentStep entries
// 2. Text parts that appear BEFORE a tool part → become the reasoning
//    for that tool call (this is the text the LLM generates explaining
//    what it is about to do, like "I'll search for flights first...")
//
// The key insight: in AI SDK v6, parts arrive in order. So a text part
// followed by a tool part means the text is the agent's reasoning for
// that tool call. We capture that relationship.

export function extractSteps(parts: any[]): AgentStep[] {
  const steps: AgentStep[] = [];
  let stepNumber = 0;
  let pendingReasoning: string | null = null;

  for (const part of parts) {
    // Text parts: capture as reasoning for the next tool call
    if (part.type === "text") {
      const text = (part as any).text;
      if (text && text.trim()) {
        // If there is already pending reasoning, append to it
        // (the LLM might output multiple text chunks before a tool call)
        pendingReasoning = pendingReasoning
          ? pendingReasoning + " " + text.trim()
          : text.trim();
      }
      continue;
    }

    // Tool parts: create an AgentStep
    if (part.type.startsWith("tool-")) {
      stepNumber++;
      const p = part as any;
      const toolName =
        p.type === "dynamic-tool" ? p.toolName : p.type.replace(/^tool-/, "");

      steps.push({
        stepNumber,
        toolName,
        toolCallId: p.toolCallId || `step-${stepNumber}`,
        args: p.input ?? {},
        status: mapStatus(p.state || "input-available"),
        result: p.output,
        reasoning: pendingReasoning || undefined,
        startedAt: Date.now() - (steps.length + 1) * 1500, // approximate
        completedAt:
          mapStatus(p.state || "input-available") === "complete"
            ? Date.now() - steps.length * 1500
            : undefined,
      });

      // Reset pending reasoning — it has been consumed by this step
      pendingReasoning = null;
    }
  }

  return steps;
}

// === REACT HOOK ===
//
// Usage in your client-side chat component:
//
//   const { messages } = useChat();
//   const lastAssistant = messages.filter(m => m.role === "assistant").at(-1);
//   const { steps, status, remainingText } = useAgentSteps(lastAssistant?.parts);
//
// It returns:
//   steps: AgentStep[] — the structured steps for AgentTaskView
//   status: "idle" | "working" | "complete" | "error"
//   remainingText: string — any text AFTER the last tool call (the final answer)

export function useAgentSteps(parts?: any[]) {
  return useMemo(() => {
    if (!parts || parts.length === 0) {
      return { steps: [], status: "idle" as const, remainingText: "" };
    }

    const steps = extractSteps(parts);

    // Find text that comes AFTER the last tool call (the final answer)
    let lastToolIndex = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type?.startsWith("tool-")) {
        lastToolIndex = i;
        break;
      }
    }

    const remainingText = parts
      .slice(lastToolIndex + 1)
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("");

    // Determine overall status
    const hasRunning = steps.some((s) => s.status === "running");
    const hasError = steps.some((s) => s.status === "error");
    const status: "idle" | "working" | "complete" | "error" = hasError
      ? "error"
      : hasRunning
      ? "working"
      : steps.length > 0
      ? "complete"
      : "idle";

    return { steps, status, remainingText };
  }, [parts]);
}
