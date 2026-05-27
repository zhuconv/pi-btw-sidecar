import type { BtwAgentDefinition } from "./agent-discovery";

export type BtwAgentSelectionMenu = {
  labels: string[];
  valueByLabel: Map<string, string>;
};

function truncateDescription(description: string, maxLength = 72): string {
  const normalized = description.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatCurrentMarker(activeAgentName: string | null, candidateAgentName: string): string {
  return activeAgentName === candidateAgentName ? "●" : "○";
}

function formatAgentOptionLabel(agent: BtwAgentDefinition, activeAgentName: string | null): string {
  return [
    formatCurrentMarker(activeAgentName, agent.name),
    agent.name,
    "—",
    truncateDescription(agent.description),
  ].join(" ");
}

export function buildBtwAgentSelectionMenu(
  agents: readonly BtwAgentDefinition[],
  activeAgentName: string | null,
): BtwAgentSelectionMenu {
  const labels: string[] = [];
  const valueByLabel = new Map<string, string>();

  for (const agent of agents) {
    const label = formatAgentOptionLabel(agent, activeAgentName);
    labels.push(label);
    valueByLabel.set(label, agent.name);
  }

  return { labels, valueByLabel };
}

export function buildBtwAgentListSummary(agents: readonly BtwAgentDefinition[], activeAgentName: string | null): string {
  const current = activeAgentName || "none";
  const lines = agents.length
    ? agents.map((agent) => `${activeAgentName === agent.name ? "*" : "-"} ${agent.name} — ${agent.description}`)
    : ["- (no agents found)"];

  return [`BTW agent: ${current}`, "Available agents:", ...lines].join("\n");
}
