export const maxRawCardBytes = 256 * 1024;

export interface NormalizedAgentCard {
  capabilities: string[];
  name: string;
  rawCard: string;
  summary: string;
}

export function normalizeAgentCard(rawCard: string): NormalizedAgentCard {
  return {
    capabilities: [],
    name: "placeholder-agent-card",
    rawCard,
    summary: "Initial scaffold normalization placeholder.",
  };
}
