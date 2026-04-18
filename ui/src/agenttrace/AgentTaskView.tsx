// agenttrace-ui/AgentTaskView.tsx
//
// v4: Approval gate renders INSIDE the timeline as part of the last step.
// No separate card. Auto-expands when approval is pending.

"use client";

import { useState, useEffect } from "react";
import type { AgentStep, StepFormatter } from "./useAgentSteps";
import { getSummary, getReasoning } from "./useAgentSteps";

export type ApprovalGateData = {
  toolName: string;
  toolCallId: string;
  action: string;
  reason: "user-requested" | "medium-risk" | "high-risk";
  consequence?: string;
  details?: Record<string, string>;
  onApprove: () => void;
  onReject: (reason: string) => void;
};

export type AgentTaskViewProps = {
  steps: AgentStep[];
  status: "idle" | "working" | "complete" | "error";
  formatters?: Record<string, StepFormatter>;
  defaultView?: "timeline" | "graph" | "compact";
  defaultExpanded?: boolean;
  approvalGate?: ApprovalGateData | null;
};

const STATUS_DOT: Record<string, string> = {
  running: "#d97706",
  complete: "#16a34a",
  error: "#dc2626",
};

const TASK_BORDER: Record<string, string> = {
  idle: "rgba(255,255,255,0.08)",
  working: "rgba(217,119,6,0.25)",
  complete: "rgba(22,163,74,0.2)",
  error: "rgba(220,38,38,0.25)",
};

const TASK_BG: Record<string, string> = {
  idle: "transparent",
  working: "rgba(217,119,6,0.06)",
  complete: "rgba(22,163,74,0.05)",
  error: "rgba(220,38,38,0.06)",
};

const TASK_TEXT: Record<string, string> = {
  idle: "#94a3b8",
  working: "#fbbf24",
  complete: "#4ade80",
  error: "#f87171",
};

// === PAUSE ICON ===

function PauseIcon({ color = "#fb923c", size = 14 }: { color?: string; size?: number }) {
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", gap: 2, flexShrink: 0 }}>
      <div style={{ width: 3, height: size * 0.7, borderRadius: 1, background: color }} />
      <div style={{ width: 3, height: size * 0.7, borderRadius: 1, background: color }} />
    </div>
  );
}

// === TIER 3: STEP DETAIL ===

type CodeResult = { code: string; status?: string; error?: string };

function CodeResultBlock({ result }: { result: CodeResult }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const lineCount = result.code ? result.code.split("\n").length : 0;
  const isError = result.status === "error";
  const statusColor = isError ? "#f87171" : "#4ade80";

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(result.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable — silent no-op
    }
  };

  const btnStyle: React.CSSProperties = {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    cursor: "pointer",
    fontFamily: "inherit",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: statusColor, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {result.status ?? "ok"}
        </span>
        <span style={{ fontSize: 11, color: "#64748b" }}>{lineCount} line{lineCount === 1 ? "" : "s"}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button type="button" onClick={onCopy} style={btnStyle}>{copied ? "Copied" : "Copy"}</button>
          <button type="button" onClick={() => setExpanded(e => !e)} style={btnStyle}>{expanded ? "Hide" : "Show"}</button>
        </div>
      </div>
      {isError && result.error && (
        <div style={{ fontSize: 12, color: "#f87171", marginBottom: 6, whiteSpace: "pre-wrap" }}>
          {result.error}
        </div>
      )}
      {expanded && (
        <pre style={{
          margin: 0,
          padding: "10px 12px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          color: "#cbd5e1",
          whiteSpace: "pre",
          overflowX: "auto",
          overflowY: "auto",
          maxHeight: 400,
        }}>
          <code>{result.code}</code>
        </pre>
      )}
    </div>
  );
}

function StepDetail({ step, formatters }: { step: AgentStep; formatters?: Record<string, StepFormatter> }) {
  const summary = getSummary(step, formatters);
  const reasoning = getReasoning(step, formatters);
  const duration = step.startedAt && step.completedAt
    ? step.completedAt - step.startedAt < 1000 ? `${step.completedAt - step.startedAt}ms` : `${((step.completedAt - step.startedAt) / 1000).toFixed(1)}s`
    : null;

  const codeResult: CodeResult | null =
    step.result && typeof step.result === "object" && typeof (step.result as any).code === "string"
      ? (step.result as CodeResult)
      : null;

  return (
    <div style={{ padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 8, fontSize: 13, lineHeight: 1.6, border: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "4px 12px" }}>
        <span style={{ color: "#64748b" }}>Tool</span>
        <span style={{ fontWeight: 600, color: "#e2e8f0" }}>{step.toolName}</span>
        <span style={{ color: "#64748b" }}>Action</span>
        <span style={{ color: "#cbd5e1" }}>{summary}</span>
        {reasoning && (<><span style={{ color: "#64748b" }}>Why</span><span style={{ color: "#cbd5e1" }}>{reasoning}</span></>)}
        <span style={{ color: "#64748b" }}>Args</span>
        <code style={{ fontSize: 11, fontFamily: "monospace", color: "#94a3b8", background: "rgba(255,255,255,0.04)", padding: "2px 6px", borderRadius: 4, wordBreak: "break-all" }}>{JSON.stringify(step.args)}</code>
        {step.status === "complete" && step.result !== undefined && (
          <><span style={{ color: "#64748b" }}>Result</span>
          {codeResult
            ? <CodeResultBlock result={codeResult} />
            : <code style={{ fontSize: 11, fontFamily: "monospace", color: "#94a3b8", background: "rgba(255,255,255,0.04)", padding: "2px 6px", borderRadius: 4, wordBreak: "break-all", maxHeight: 100, overflow: "auto", display: "block" }}>{JSON.stringify(step.result, null, 2)}</code>}
          </>
        )}
        {duration && (<><span style={{ color: "#64748b" }}>Time</span><span style={{ color: "#cbd5e1" }}>{duration}</span></>)}
        {step.status === "error" && (<><span style={{ color: "#f87171" }}>Error</span><span style={{ color: "#f87171" }}>{step.result ? JSON.stringify(step.result) : "Tool execution failed"}</span></>)}
      </div>
    </div>
  );
}

// === INLINE APPROVAL UI (rendered inside timeline step) ===

function InlineApprovalUI({ gate }: { gate: ApprovalGateData }) {
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const isUserRequested = gate.reason === "user-requested";
  const isHighRisk = gate.reason === "high-risk";

  // Colors based on reason
  const accentColor = isUserRequested ? "#60a5fa" : isHighRisk ? "#f87171" : "#fb923c";
  const accentBg = isUserRequested ? "rgba(96,165,250,0.06)" : isHighRisk ? "rgba(248,113,113,0.06)" : "rgba(234,88,12,0.06)";
  const accentBorder = isUserRequested ? "rgba(96,165,250,0.15)" : isHighRisk ? "rgba(248,113,113,0.15)" : "rgba(234,88,12,0.15)";

  return (
    <div style={{ marginTop: 10 }}>
      {/* Consequence warning — only for medium/high risk */}
      {!isUserRequested && gate.consequence && (
        <div style={{ padding: "10px 14px", background: accentBg, borderRadius: 8, border: `1px solid ${accentBorder}`, marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: accentColor, marginBottom: 4 }}>
            {isHighRisk ? "Potential impact" : "Please note"}
          </div>
          <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 }}>{gate.consequence}</div>
        </div>
      )}

      {/* Action details — if provided */}
      {gate.details && Object.keys(gate.details).length > 0 && (
        <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10, fontSize: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "4px 12px" }}>
            {Object.entries(gate.details).map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <span style={{ color: "#64748b", textTransform: "capitalize" }}>{k.replace(/([A-Z])/g, " $1").trim()}</span>
                <span style={{ color: "#e2e8f0" }}>{String(v)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={gate.onApprove} style={{ padding: "7px 18px", borderRadius: 8, border: "1px solid rgba(22,163,74,0.4)", background: "rgba(22,163,74,0.1)", color: "#4ade80", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {isUserRequested ? "Confirm" : "Approve"}
        </button>
        <button onClick={() => setShowRejectInput(true)} style={{ padding: "7px 18px", borderRadius: 8, border: "1px solid rgba(220,38,38,0.4)", background: "rgba(220,38,38,0.1)", color: "#f87171", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {isUserRequested ? "No, change" : "Reject"}
        </button>
      </div>

      {showRejectInput && (
        <div style={{ marginTop: 8 }}>
          <input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={isUserRequested ? "What would you prefer instead?" : "Tell the agent what to do instead (optional)"}
            autoFocus
            style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", fontSize: 13, background: "rgba(255,255,255,0.04)", color: "#f1f5f9", outline: "none", boxSizing: "border-box" }}
            onKeyDown={(e) => { if (e.key === "Enter") gate.onReject(rejectReason); }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button onClick={() => gate.onReject(rejectReason)} style={{ padding: "5px 14px", borderRadius: 6, border: "none", background: "rgba(220,38,38,0.3)", color: "#f87171", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
              {rejectReason.trim() ? (isUserRequested ? "Send feedback" : "Reject with reason") : (isUserRequested ? "Decline" : "Reject without reason")}
            </button>
            <button onClick={() => setShowRejectInput(false)} style={{ padding: "5px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)", background: "transparent", color: "#64748b", fontSize: 12, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// === TIER 2A: TIMELINE ===

function TimelineView({ steps, formatters, approvalGate }: { steps: AgentStep[]; formatters?: Record<string, StepFormatter>; approvalGate?: ApprovalGateData | null }) {
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  return (
    <div>
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const summary = getSummary(step, formatters);
        const reasoning = getReasoning(step, formatters);
        const isExpanded = expandedStep === step.stepNumber;
        const isPendingApproval = isLast && approvalGate;

        return (
          <div key={step.stepNumber} style={{ display: "flex", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 16, flexShrink: 0 }}>
              {isPendingApproval ? (
                <div style={{ marginTop: 2 }}><PauseIcon color={approvalGate!.reason === "user-requested" ? "#60a5fa" : approvalGate!.reason === "high-risk" ? "#f87171" : "#fb923c"} size={14} /></div>
              ) : (
                <div style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: STATUS_DOT[step.status] || "#d97706",
                  marginTop: 4, flexShrink: 0,
                  boxShadow: step.status === "running" ? `0 0 0 3px ${STATUS_DOT[step.status]}30` : "none",
                }} />
              )}
              {!isLast && <div style={{ width: 1.5, flex: 1, marginTop: 4, background: step.status === "complete" ? "rgba(22,163,74,0.4)" : "rgba(255,255,255,0.08)" }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: isLast ? 0 : 14 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.4 }}>
                {summary}
                {isPendingApproval && (
                  <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 4,
                    background: approvalGate!.reason === "user-requested" ? "rgba(96,165,250,0.15)" : approvalGate!.reason === "high-risk" ? "rgba(248,113,113,0.15)" : "rgba(234,88,12,0.15)",
                    color: approvalGate!.reason === "user-requested" ? "#60a5fa" : approvalGate!.reason === "high-risk" ? "#f87171" : "#fb923c",
                    verticalAlign: "middle", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                    {approvalGate!.reason === "user-requested" ? "Confirm" : approvalGate!.reason === "high-risk" ? "High risk" : "Needs your input"}
                  </span>
                )}
                {!isPendingApproval && step.status === "running" && (
                  <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, padding: "1px 8px", borderRadius: 4, background: "rgba(217,119,6,0.15)", color: "#fbbf24", verticalAlign: "middle" }}>Running</span>
                )}
              </div>
              {reasoning && <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>{reasoning}</div>}

              {/* Approval gate UI — inline inside the timeline step */}
              {isPendingApproval && <InlineApprovalUI gate={approvalGate} />}

              {/* Show more for completed steps */}
              {!isPendingApproval && step.status !== "running" && (
                <button onClick={() => setExpandedStep(isExpanded ? null : step.stepNumber)} style={{ marginTop: 4, padding: 0, border: "none", background: "none", fontSize: 12, color: "#60a5fa", cursor: "pointer" }}>
                  {isExpanded ? "Hide details" : "Show more"}
                </button>
              )}
              {isExpanded && <div style={{ marginTop: 8 }}><StepDetail step={step} formatters={formatters} /></div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// === TIER 2B: GRAPH ===

function GraphView({ steps, formatters }: { steps: AgentStep[]; formatters?: Record<string, StepFormatter> }) {
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const selected = steps.find((s) => s.stepNumber === selectedStep);
  const nodeW = 260, nodeH = 48, gapY = 24, startX = 210, startY = 16;

  return (
    <div>
      <svg width="100%" viewBox={`0 0 680 ${steps.length * (nodeH + gapY) + 40}`} style={{ display: "block" }}>
        <defs><marker id="agv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></marker></defs>
        {steps.map((step, i) => {
          const y = startY + i * (nodeH + gapY);
          const isSelected = selectedStep === step.stepNumber;
          const summary = getSummary(step, formatters);
          const fill = "rgba(255,255,255,0.03)";
          const stroke = isSelected ? "#60a5fa" : "rgba(255,255,255,0.08)";
          return (
            <g key={step.stepNumber} onClick={() => setSelectedStep(isSelected ? null : step.stepNumber)} style={{ cursor: "pointer" }}>
              {i < steps.length - 1 && <line x1={startX + nodeW / 2} y1={y + nodeH} x2={startX + nodeW / 2} y2={y + nodeH + gapY} stroke={step.status === "complete" ? "rgba(22,163,74,0.4)" : "rgba(255,255,255,0.1)"} strokeWidth="1.5" markerEnd="url(#agv-arrow)" strokeDasharray={step.status !== "complete" ? "4 3" : "none"} />}
              <rect x={startX} y={y} width={nodeW} height={nodeH} rx={8} fill={fill} stroke={stroke} strokeWidth={isSelected ? 1.5 : 0.5} />
              <text x={startX + nodeW / 2} y={y + nodeH / 2 - 6} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 12, fontWeight: 600, fill: "#e2e8f0" }}>{summary.length > 32 ? summary.slice(0, 30) + "..." : summary}</text>
              <text x={startX + nodeW / 2} y={y + nodeH / 2 + 10} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 11, fill: "#64748b" }}>{step.toolName}</text>
            </g>
          );
        })}
      </svg>
      {selected && <div style={{ marginTop: 8 }}><StepDetail step={selected} formatters={formatters} /></div>}
    </div>
  );
}

// === TIER 2C: COMPACT ===

function getCompactLabel(step: AgentStep): string {
  const vals = Object.values(step.args);
  if (vals.length > 0 && vals[0] !== undefined) {
    const val = String(vals[0]);
    return val.length > 22 ? val.slice(0, 20) + "..." : val;
  }
  return humanizeName(step.toolName);
}

function getCompactToolTag(step: AgentStep): string {
  const map: Record<string, string> = { webSearch: "Search", calculator: "Calc", getCurrentDateTime: "Date", executeTrade: "Trade", runTests: "Tests", buildProject: "Build", deployToProduction: "Deploy" };
  return map[step.toolName] || humanizeName(step.toolName);
}

function CompactView({ steps, formatters }: { steps: AgentStep[]; formatters?: Record<string, StepFormatter> }) {
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const selected = steps.find((s) => s.stepNumber === selectedStep);

  return (
    <div>
      <div style={{ display: "flex", gap: 4, alignItems: "stretch", overflowX: "auto", paddingBottom: 8 }}>
        {steps.map((step, i) => {
          const isSelected = selectedStep === step.stepNumber;
          return (
            <div key={step.stepNumber} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div onClick={() => setSelectedStep(isSelected ? null : step.stepNumber)} style={{
                padding: "8px 12px", background: "rgba(255,255,255,0.03)",
                border: `1px solid ${isSelected ? "#60a5fa" : "rgba(255,255,255,0.08)"}`,
                borderRadius: 8, cursor: "pointer", minWidth: 120, maxWidth: 200, transition: "border-color 0.15s",
              }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{getCompactToolTag(step)}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3 }}>{step.status === "running" ? "Running..." : getCompactLabel(step)}</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{getCompactResult(step)}</div>
              </div>
              {i < steps.length - 1 && (
                <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}><path d="M3 8H13M10 5L13 8L10 11" stroke={step.status === "complete" ? "rgba(22,163,74,0.5)" : "rgba(255,255,255,0.15)"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
              )}
            </div>
          );
        })}
      </div>
      {selected && <div style={{ marginTop: 8 }}><StepDetail step={selected} formatters={formatters} /></div>}
    </div>
  );
}

function humanizeName(name: string): string {
  const spaced = name.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function getCompactResult(step: AgentStep): string {
  if (step.status === "running") return "";
  if (step.status === "error") return "Error";
  if (!step.result) return "Done";
  const r = step.result as any;
  if (r.formatted) return r.formatted;
  if (r.result !== undefined) return String(r.result);
  if (r.results?.length) return `${r.results.length} results`;
  if (r.status) return r.status;
  return "Done";
}

// === MAIN ===

export function AgentTaskView({ steps, status, formatters, defaultView = "timeline", defaultExpanded = false, approvalGate }: AgentTaskViewProps) {
  // Auto-expand when approval is pending
  const [expanded, setExpanded] = useState(defaultExpanded || !!approvalGate);
  const [view, setView] = useState<"timeline" | "graph" | "compact">(defaultView);

  // Auto-expand when approval gate appears (without causing render loop)
  useEffect(() => {
    if (approvalGate && !expanded) setExpanded(true);
  }, [!!approvalGate]);

  if (steps.length === 0) return null;

  const hasApproval = !!approvalGate;
  const currentStep = steps.find((s) => s.status === "running") || steps[steps.length - 1];
  const currentSummary = currentStep ? getSummary(currentStep, formatters) : "Waiting...";

  // When approval is pending, style based on reason
  const effectiveStatus = hasApproval ? "working" : status;
  const gateReason = approvalGate?.reason || "medium-risk";
  const gateAccent = gateReason === "user-requested" ? { border: "rgba(96,165,250,0.35)", bg: "rgba(96,165,250,0.04)", text: "#60a5fa", icon: "#60a5fa" }
    : gateReason === "high-risk" ? { border: "rgba(248,113,113,0.35)", bg: "rgba(248,113,113,0.04)", text: "#f87171", icon: "#f87171" }
    : { border: "rgba(234,88,12,0.35)", bg: "rgba(234,88,12,0.04)", text: "#fb923c", icon: "#fb923c" };
  const borderColor = hasApproval ? gateAccent.border : (TASK_BORDER[status] || TASK_BORDER.idle);
  const bgColor = hasApproval ? gateAccent.bg : (TASK_BG[status] || TASK_BG.idle);
  const textColor = hasApproval ? gateAccent.text : (TASK_TEXT[status] || TASK_TEXT.idle);

  return (
    <div style={{
      borderRadius: 10,
      border: `1.5px solid ${borderColor}`,
      overflow: "hidden", marginBottom: 12,
      animation: hasApproval ? "agv-pulse 2s ease-in-out infinite" : "none",
    }}>

      <style>{`
        @keyframes agv-pulse {
          0%,100%{ border-color: ${hasApproval ? gateAccent.border.replace("0.35", "0.2") : "transparent"} }
          50%{ border-color: ${hasApproval ? gateAccent.border.replace("0.35", "0.55") : "transparent"} }
        }
      `}</style>
      {/* TIER 1: Collapsed */}
      <div onClick={() => setExpanded(!expanded)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer", background: expanded ? bgColor : "transparent", transition: "background 0.15s", userSelect: "none" }}>
        {hasApproval ? (
          <PauseIcon color={gateAccent.icon} size={12} />
        ) : (
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_DOT[currentStep?.status || "complete"] || "#16a34a", flexShrink: 0 }} />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#f1f5f9" }}>{"Step " + (currentStep?.stepNumber || 0) + ": "}</span>
          <span style={{ fontSize: 13, color: "#94a3b8" }}>{currentSummary}</span>
        </div>

        {!expanded && (
          <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 10px", borderRadius: 4, background: bgColor, color: textColor, border: `1px solid ${borderColor}`, flexShrink: 0 }}>
            {hasApproval ? (gateReason === "user-requested" ? "Confirm" : gateReason === "high-risk" ? "High risk" : "Needs your input") : effectiveStatus === "working" ? `${steps.filter((s) => s.status === "complete").length} done` : effectiveStatus === "complete" ? "Complete" : effectiveStatus === "error" ? "Error" : "Idle"}
          </span>
        )}

        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", flexShrink: 0 }}>
          <path d="M4 6L8 10L12 6" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* TIER 2: Expanded */}
      {expanded && (
        <div style={{ padding: "12px 14px 16px", borderTop: `1px solid ${borderColor}`, background: bgColor, color: "#e2e8f0" }}>
          {steps.length > 1 && !hasApproval && (
            <div style={{ display: "flex", gap: 2, marginBottom: 12 }}>
              {(["timeline", "graph", "compact"] as const).map((v) => (
                <button key={v} onClick={(e) => { e.stopPropagation(); setView(v); }} style={{
                  padding: "4px 12px", fontSize: 12, fontWeight: 500,
                  border: `1px solid ${view === v ? "rgba(96,165,250,0.3)" : "rgba(255,255,255,0.08)"}`,
                  background: view === v ? "rgba(96,165,250,0.1)" : "transparent",
                  color: view === v ? "#60a5fa" : "#64748b",
                  cursor: "pointer",
                  borderRadius: v === "timeline" ? "6px 0 0 6px" : v === "compact" ? "0 6px 6px 0" : "0",
                }}>
                  {v === "timeline" ? "Timeline" : v === "graph" ? "Graph" : "Compact"}
                </button>
              ))}
            </div>
          )}
          {/* When approval is pending, force timeline view */}
          {(hasApproval || view === "timeline") && <TimelineView steps={steps} formatters={formatters} approvalGate={approvalGate} />}
          {!hasApproval && view === "graph" && <GraphView steps={steps} formatters={formatters} />}
          {!hasApproval && view === "compact" && <CompactView steps={steps} formatters={formatters} />}
        </div>
      )}

    </div>
  );
}
