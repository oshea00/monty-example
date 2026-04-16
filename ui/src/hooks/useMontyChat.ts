"use client";

import { useState, useCallback, useRef } from "react";
import type {
  ChatMessage,
  ChatStatus,
  MessagePart,
  SSEEvent,
} from "../types/monty";

export function useMontyChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startNewSession = useCallback(async (oldSessionId?: string | null) => {
    // Clean up previous session
    if (oldSessionId) {
      await fetch(`/api/sessions/${oldSessionId}`, { method: "DELETE" }).catch(
        () => {}
      );
    }
    const res = await fetch("/api/sessions", { method: "POST" });
    const { session_id } = await res.json();
    setSessionId(session_id);
    setMessages([]);
    setStatus("idle");
    return session_id as string;
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      // Ensure we have a session
      let sid = sessionId;
      if (!sid) {
        sid = await startNewSession(null);
      }

      // Abort any in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      };
      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        parts: [],
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStatus("submitted");

      // Track part indices for in-place updates keyed by callId
      const partIndexMap = new Map<string, number>();
      // We maintain a local mutable copy to avoid stale closure issues
      let currentParts: MessagePart[] = [];

      const updateAssistant = (parts: MessagePart[]) => {
        currentParts = parts;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, parts: [...parts] } : m
          )
        );
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sid, message: text }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`HTTP ${res.status}: ${err}`);
        }

        setStatus("streaming");

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: SSEEvent;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (event.type === "step_start") {
              const toolPart: MessagePart = {
                type: `tool-${event.name}`,
                toolCallId: event.callId,
                input: event.input,
                state: "input-available",
              };
              const idx = currentParts.length;
              partIndexMap.set(event.callId, idx);
              updateAssistant([...currentParts, toolPart]);
            } else if (event.type === "step_complete") {
              const idx = partIndexMap.get(event.callId);
              if (idx !== undefined) {
                const updated = [...currentParts];
                const prev = updated[idx] as Extract<
                  MessagePart,
                  { type: string; state: string }
                >;
                const outputObj = event.output as Record<string, unknown> | null;
                const isError =
                  outputObj &&
                  typeof outputObj === "object" &&
                  outputObj.status === "error";
                updated[idx] = {
                  ...prev,
                  state: isError ? "output-error" : "output-available",
                  output: event.output,
                };
                updateAssistant(updated);
              }
            } else if (event.type === "text_delta") {
              const last = currentParts[currentParts.length - 1];
              if (last?.type === "text") {
                const updated = [...currentParts];
                updated[updated.length - 1] = {
                  type: "text",
                  text: (last as { type: "text"; text: string }).text + event.text,
                };
                updateAssistant(updated);
              } else {
                updateAssistant([
                  ...currentParts,
                  { type: "text", text: event.text },
                ]);
              }
            } else if (event.type === "done") {
              setStatus("idle");
              break outer;
            } else if (event.type === "error") {
              updateAssistant([
                ...currentParts,
                { type: "text", text: `Error: ${event.message}` },
              ]);
              setStatus("error");
              break outer;
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          setStatus("error");
          updateAssistant([
            ...currentParts,
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        }
      }
    },
    [sessionId, startNewSession]
  );

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    startNewSession(sessionId);
  }, [sessionId, startNewSession]);

  return {
    messages,
    status,
    sessionId,
    sendMessage,
    newChat,
  };
}
