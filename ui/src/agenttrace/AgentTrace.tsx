// agenttrace-ui/AgentTrace.tsx
//
// THE WRAPPER - the only component users need to import.
//
// Usage:
//   import { AgentTrace } from "@/agenttrace-ui/AgentTrace";
//
//   <AgentTrace parts={message.parts} />
//
// With approval gates:
//   <AgentTrace
//     parts={message.parts}
//     addToolOutput={addToolOutput}
//     isStreaming={status === "submitted" || status === "streaming"}
//   />

"use client";

import { useMemo } from "react";
import { useAgentSteps } from "./useAgentSteps";
import { AgentTaskView } from "./AgentTaskView";
import type { StepFormatter } from "./useAgentSteps";
import type { ApprovalGateData } from "./AgentTaskView";

// === TYPES ===

export type AgentTraceProps = {
  /** The message.parts array from AI SDK v6 useChat */
  parts: any[];
  /** Optional: pass addToolOutput from useChat to enable approval gates */
  addToolOutput?: (opts: any) => void;
  /** Optional: true when this message is still being streamed */
  isStreaming?: boolean;
  /** Optional: custom formatters for specific tool names */
  formatters?: Record<string, StepFormatter>;
  /** Optional: default visualization mode */
  defaultView?: "timeline" | "graph" | "compact";
};

// === INTERNAL HELPERS ===

// AI SDK v6 puts tool name in part.type as "tool-webSearch", not in part.toolName
function getToolName(part: any): string {
  return part.toolName || (part.type?.startsWith("tool-") ? part.type.slice(5) : "");
}

// Check if any message parts contain a pending confirmAction awaiting user input.
// Use this to disable the send button while the agent is waiting for approval.
export function hasPendingApproval(parts: any[]): boolean {
  return parts.some(
    (p: any) =>
      p.type?.startsWith("tool-") &&
      getToolName(p) === "confirmAction" &&
      p.state === "input-available"
  );
}

// Remove consecutive duplicate text parts (SDK sometimes sends duplicates during streaming)
function deduplicateText(parts: any[]): any[] {
  const out: any[] = [];
  let lastText = "";
  for (const part of parts) {
    if (part.type === "text") {
      const text = (part as any).text || "";
      if (text.trim() && text.trim() !== lastText.trim()) {
        out.push(part);
        lastText = text;
      }
    } else {
      out.push(part);
      lastText = "";
    }
  }
  return out;
}

// Extract the first text part that appears before any tool call (the agent's intro)
function extractIntroText(parts: any[]): string {
  for (const p of parts) {
    if ((p as any).type === "text" && (p as any).text?.trim()) {
      return (p as any).text.trim();
    }
    if ((p as any).type?.startsWith("tool-")) break;
  }
  return "";
}

// Simple markdown rendering: **bold**, bullet lists, numbered lists, headings
function renderMarkdown(text: string) {
  return text.split("\n").map((line, i) => {
    const t = line.trim();
    if (t.startsWith("### ")) return <h3 key={i} style={{ fontSize: 15, fontWeight: 600, margin: "12px 0 4px" }}>{t.slice(4)}</h3>;
    if (t.startsWith("## ")) return <h2 key={i} style={{ fontSize: 16, fontWeight: 600, margin: "14px 0 6px" }}>{t.slice(3)}</h2>;
    if (t.startsWith("- ") || t.startsWith("* ")) {
      return (
        <div key={i} style={{ display: "flex", gap: 8, margin: "2px 0", paddingLeft: 4 }}>
          <span style={{ opacity: 0.5 }}>•</span>
          <span>{renderBold(t.slice(2))}</span>
        </div>
      );
    }
    if (/^\d+\.\s/.test(t)) {
      const m = t.match(/^(\d+)\.\s(.*)$/);
      if (m) {
        return (
          <div key={i} style={{ display: "flex", gap: 8, margin: "2px 0", paddingLeft: 4 }}>
            <span style={{ opacity: 0.5, minWidth: 16 }}>{m[1]}.</span>
            <span>{renderBold(m[2])}</span>
          </div>
        );
      }
    }
    if (t === "") return <div key={i} style={{ height: 8 }} />;
    return <p key={i} style={{ margin: "4px 0" }}>{renderBold(t)}</p>;
  });
}

function renderBold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((s, i) =>
    s.startsWith("**") && s.endsWith("**")
      ? <strong key={i} style={{ fontWeight: 600 }}>{s.slice(2, -2)}</strong>
      : s
  );
}

// Default formatters for common tool names
const DEFAULT_FORMATTERS: Record<string, StepFormatter> = {
  calculator: { summary: (args) => `Calculated: ${(args as any).expression}` },
  confirmAction: { summary: (args) => (args as any).action || "Confirm action" },
};

// === THE COMPONENT ===

export function AgentTrace({
  parts,
  addToolOutput,
  isStreaming = false,
  formatters,
  defaultView = "timeline",
}: AgentTraceProps) {
  // Clean up parts
  const cleanParts = useMemo(() => deduplicateText(parts), [parts]);

  // Convert to steps
  const { steps, status, remainingText } = useAgentSteps(cleanParts);

  // Merge user formatters with defaults
  const mergedFormatters = useMemo(
    () => ({ ...DEFAULT_FORMATTERS, ...formatters }),
    [formatters]
  );

  // Prevent false "Complete" while chat is still streaming
  const displayStatus = (isStreaming && status === "complete") ? "working" : status;

  // Extract intro text (text before first tool call)
  const introText = useMemo(
    () => (steps.length > 0 ? extractIntroText(cleanParts) : ""),
    [cleanParts, steps.length]
  );

  // Find pending confirmAction tool (client-side tool with no execute function)
  const pendingPart = useMemo(
    () =>
      addToolOutput
        ? cleanParts.find(
            (p: any) =>
              p.type?.startsWith("tool-") &&
              getToolName(p) === "confirmAction" &&
              p.state === "input-available"
          )
        : null,
    [cleanParts, addToolOutput]
  );

  // Build approval gate data if confirmAction is pending
  const approvalGate: ApprovalGateData | null =
    pendingPart && addToolOutput
      ? {
          toolName: "confirmAction",
          toolCallId: pendingPart.toolCallId,
          action: pendingPart.input?.action || "Confirm this action",
          reason: pendingPart.input?.reason || "medium-risk",
          consequence: pendingPart.input?.consequence,
          details: pendingPart.input?.details,
          onApprove: () => {
            addToolOutput({
              tool: "confirmAction",
              toolCallId: pendingPart.toolCallId,
              output: { approved: true, message: "User approved this action." },
            });
          },
          onReject: (reason: string) => {
            addToolOutput({
              tool: "confirmAction",
              toolCallId: pendingPart.toolCallId,
              output: {
                approved: false,
                rejected: true,
                reason: reason.trim() || "User rejected this action.",
              },
            });
          },
        }
      : null;

  return (
    <div>
      {/* Intro text above steps */}
      {introText && steps.length > 0 && (
        <div style={{ padding: "0 0 10px", fontSize: 14, lineHeight: 1.6, opacity: 0.8 }}>
          {introText}
        </div>
      )}

      {/* Agent step visualization */}
      {steps.length > 0 && (
        <AgentTaskView
          steps={steps}
          status={displayStatus}
          formatters={mergedFormatters}
          defaultView={defaultView}
          approvalGate={approvalGate}
        />
      )}

      {/* Final answer text (after all tool calls complete) */}
      {remainingText && !isStreaming && (
        <div style={{ padding: "10px 0", fontSize: 14, lineHeight: 1.7, fontFamily: "var(--font-roboto-mono), 'Roboto Mono', monospace" }}>
          {renderMarkdown(remainingText)}
        </div>
      )}

      {/* Plain text response (no tool calls at all) */}
      {steps.length === 0 &&
        cleanParts
          .filter((p: any) => p.type === "text" && p.text?.trim())
          .map((p: any, i: number) => (
            <div key={i} style={{ padding: "10px 0", fontSize: 14, lineHeight: 1.7, fontFamily: "var(--font-roboto-mono), 'Roboto Mono', monospace" }}>
              {renderMarkdown(p.text)}
            </div>
          ))}
    </div>
  );
}
