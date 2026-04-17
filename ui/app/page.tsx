"use client";

import { useEffect, useRef, useState } from "react";
import { AgentTrace } from "../src/agenttrace/AgentTrace";
import type { StepFormatter } from "../src/agenttrace/useAgentSteps";
import { useMontyChat } from "../src/hooks/useMontyChat";

const FORMATTERS: Record<string, StepFormatter> = {
  phase1_discovery: {
    summary: (_args, result) => {
      if (Array.isArray(result))
        return `Identified ${result.length} tool call(s): ${(result as { name: string }[])
          .map((t) => t.name)
          .join(", ")}`;
      return "Direct answer — no data fetch needed";
    },
  },
  code_generation: {
    summary: (args) =>
      `Generate code${(args.attempt as number) > 1 ? ` (retry ${args.attempt})` : ""}`,
  },
  code_execution: {
    summary: (args) =>
      `Execute in Monty sandbox${(args.attempt as number) > 1 ? ` (retry ${args.attempt})` : ""}`,
  },
  phase3_answer: {
    summary: () => "Generate final answer",
  },
};

// CUSTOMIZE: starter prompts shown in the empty state. Also review the header title,
// empty-state copy, and textarea placeholder below — all domain-specific.
const EXAMPLE_QUESTIONS = [
  "How much did each team member spend in Q3?",
  "Who went over budget this year?",
  "Show me Alice's expenses by category",
  "What were the top 3 expenses across the team?",
];

export default function Page() {
  const { messages, status, sendMessage, newChat } = useMontyChat();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isLoading = status === "submitted" || status === "streaming";

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        maxWidth: 860,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid #1e1e1e",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#fff" }}>
            Monty Expense Analyst
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
            Three-phase LLM · sandboxed code execution
          </div>
        </div>
        <button
          onClick={newChat}
          style={{
            padding: "6px 14px",
            background: "transparent",
            border: "1px solid #333",
            borderRadius: 6,
            color: "#aaa",
            fontSize: 13,
          }}
        >
          New chat
        </button>
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 24,
              color: "#666",
              paddingTop: 60,
            }}
          >
            <div style={{ fontSize: 32 }}>📊</div>
            <div style={{ fontSize: 15, color: "#aaa", textAlign: "center" }}>
              Ask a question about team expenses
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                width: "100%",
                maxWidth: 480,
              }}
            >
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  style={{
                    padding: "10px 16px",
                    background: "#141414",
                    border: "1px solid #2a2a2a",
                    borderRadius: 8,
                    color: "#ccc",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const isStreaming = isLast && isLoading;

          if (msg.role === "user") {
            const textPart = msg.parts.find((p) => p.type === "text");
            return (
              <div key={msg.id} style={{ display: "flex", justifyContent: "flex-end" }}>
                <div
                  style={{
                    maxWidth: "72%",
                    padding: "10px 14px",
                    background: "#1a1a2e",
                    border: "1px solid #2a2a4a",
                    borderRadius: 12,
                    fontSize: 14,
                    lineHeight: 1.6,
                    color: "#e0e0ff",
                  }}
                >
                  {textPart && "text" in textPart ? textPart.text : ""}
                </div>
              </div>
            );
          }

          // Assistant message
          return (
            <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 11, color: "#444", paddingLeft: 2 }}>
                Assistant
              </div>
              <div
                style={{
                  padding: "14px 16px",
                  background: "#111",
                  border: "1px solid #1e1e1e",
                  borderRadius: 12,
                }}
              >
                {msg.parts.length === 0 && isStreaming ? (
                  <div style={{ color: "#555", fontSize: 13 }}>Thinking…</div>
                ) : (
                  <AgentTrace
                    parts={msg.parts}
                    isStreaming={isStreaming}
                    defaultView="timeline"
                    formatters={FORMATTERS}
                  />
                )}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Input form */}
      <div
        style={{
          padding: "16px 20px",
          borderTop: "1px solid #1e1e1e",
          flexShrink: 0,
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
            background: "#111",
            border: "1px solid #2a2a2a",
            borderRadius: 10,
            padding: "10px 14px",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about team expenses…"
            disabled={isLoading}
            rows={1}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              color: "#e8e8e8",
              lineHeight: 1.5,
              maxHeight: 120,
              overflowY: "auto",
            }}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            style={{
              padding: "6px 16px",
              background: isLoading || !input.trim() ? "#1e1e1e" : "#2563eb",
              border: "none",
              borderRadius: 7,
              color: isLoading || !input.trim() ? "#555" : "#fff",
              fontSize: 13,
              fontWeight: 500,
              transition: "background 0.15s",
            }}
          >
            {isLoading ? "…" : "Send"}
          </button>
        </form>
        <div style={{ fontSize: 11, color: "#333", marginTop: 8, textAlign: "center" }}>
          Enter to send · Shift+Enter for newline
        </div>
      </div>
    </div>
  );
}
