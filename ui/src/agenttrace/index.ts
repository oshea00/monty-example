// agenttrace-ui — public API

// The main component. This is what most users need.
export { AgentTrace, hasPendingApproval } from "./AgentTrace";
export type { AgentTraceProps } from "./AgentTrace";

// Lower-level components for advanced usage
export { AgentTaskView } from "./AgentTaskView";
export type { AgentTaskViewProps, ApprovalGateData } from "./AgentTaskView";

export { useAgentSteps, extractSteps, getSummary, getReasoning } from "./useAgentSteps";
export type { AgentStep, StepFormatter } from "./useAgentSteps";
