import type { ThreadEntry } from "../../thread/thread-types.js";
import type { Milestone } from "./activity-map.js";

const PREAMBLE =
  "You are the orchestrator narrating a live coding run to the operator. " +
  "Reply with ONE short paragraph of plain prose. No JSON, no code fences, " +
  "no tool use, no lists — just a brief, human sentence or two about what " +
  "just happened and what's next.";

const MAX_ENTRIES = 20;
const MAX_TEXT_LEN = 200;

function truncate(text: string): string {
  return text.length > MAX_TEXT_LEN ? `${text.slice(0, MAX_TEXT_LEN)}...` : text;
}

function renderEntry(entry: ThreadEntry): string {
  switch (entry.type) {
    case "operator_msg":
      return `operator: ${truncate(entry.text)}`;
    case "orchestrator_msg":
      return `you: ${truncate(entry.text)}`;
    case "activity":
      return `[${entry.kind} ${entry.status}] ${truncate(entry.summary)}`;
    case "plan":
      return `plan: ${entry.specs.length} task(s)`;
    case "run_link":
      return `run: ${entry.runId}`;
    default:
      return "";
  }
}

function renderEntries(entries: ThreadEntry[]): string {
  return entries
    .slice(-MAX_ENTRIES)
    .map(renderEntry)
    .join("\n");
}

function renderMilestone(milestone: Milestone): string {
  switch (milestone.kind) {
    case "run_started":
      return `- run_started: ${milestone.runId}`;
    case "task_active":
      return `- task_active: ${milestone.title} (${milestone.taskId})`;
    case "task_done":
      return `- task_done: ${milestone.title} (${milestone.taskId})`;
    case "task_escalated":
      return `- task_escalated: ${milestone.title} (${milestone.taskId})`;
    case "run_finished":
      return `- run_finished: ${milestone.runId}`;
    default:
      return "";
  }
}

function renderMilestones(milestones: Milestone[]): string {
  return milestones.map(renderMilestone).join("\n");
}

export function buildNarrationPrompt(entries: ThreadEntry[], milestones: Milestone[]): string {
  return (
    `${PREAMBLE}\n\n` +
    `Conversation & run so far:\n${renderEntries(entries)}\n\n` +
    `What just happened:\n${renderMilestones(milestones)}\n\n` +
    `Narrate this to the operator now.`
  );
}

export function buildMidRunReplyPrompt(
  entries: ThreadEntry[],
  stateSummary: string,
  question: string,
): string {
  return (
    `${PREAMBLE}\n\n` +
    `Conversation & run so far:\n${renderEntries(entries)}\n\n` +
    `Current run state: ${stateSummary}\n\n` +
    `The operator asks: ${question}\n\n` +
    `Answer them directly and briefly.`
  );
}
