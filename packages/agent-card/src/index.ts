export const maxRawCardBytes = 256 * 1024;
export const defaultCardProfileId = "a2a-default";

export interface NormalizedAgentCard {
  cardProfileId: string;
  capabilities: string[];
  displayName: string;
  invocationEndpoint: string | null;
  rawCard: string;
  summary: string;
  tags: string[];
}

interface CardProfileDefinition {
  normalize(rawCard: string): ParsedAgentCard;
}

interface ParsedAgentCard {
  capabilities: string[];
  invocationEndpoint: string | null;
  name: string;
  summary: string;
  tags: string[];
}

export class UnknownCardProfileError extends Error {
  readonly cardProfileId: string;

  constructor(cardProfileId: string) {
    super(`Unknown card profile '${cardProfileId}'.`);
    this.cardProfileId = cardProfileId;
  }
}

export class InvalidAgentCardError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function assertObjectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidAgentCardError("Raw card must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  fallbackKeys: string[] = [],
): string {
  const keys = [key, ...fallbackKeys];

  for (const candidate of keys) {
    const value = record[candidate];

    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  throw new InvalidAgentCardError(`Raw card is not valid: expected a non-empty '${key}' string.`);
}

function readOptionalString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value !== "string" || value.trim() === "") {
      throw new InvalidAgentCardError(`Raw card is not valid: expected '${key}' to be a string.`);
    }

    return value.trim();
  }

  return null;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new InvalidAgentCardError(`Raw card is not valid: expected '${key}' to be an array.`);
  }

  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvalidAgentCardError(
        `Raw card is not valid: expected '${key}' to contain only non-empty strings.`,
      );
    }

    return entry.trim();
  });

  return [...new Set(strings)].sort();
}

function parseDefaultAgentCard(rawCard: string): ParsedAgentCard {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawCard);
  } catch {
    throw new InvalidAgentCardError("Raw card is not valid JSON.");
  }

  const record = assertObjectRecord(parsed);

  return {
    capabilities: readStringArray(record, "capabilities"),
    invocationEndpoint: readOptionalString(record, ["invocationEndpoint", "url"]),
    name: readRequiredString(record, "name"),
    summary: readRequiredString(record, "summary", ["description"]),
    tags: readStringArray(record, "tags"),
  };
}

function createCardProfileRegistry(
  profiles: Record<string, CardProfileDefinition>,
): ReadonlyMap<string, CardProfileDefinition> {
  return new Map(Object.entries(profiles));
}

const defaultCardProfileRegistry = createCardProfileRegistry({
  "a2a-default": {
    normalize: parseDefaultAgentCard,
  },
  "a2a-v1": {
    normalize: parseDefaultAgentCard,
  },
});

export function normalizeAgentCard(
  rawCard: string,
  options: {
    cardProfileId?: string;
    registry?: ReadonlyMap<string, CardProfileDefinition>;
  } = {},
): NormalizedAgentCard {
  const cardProfileId = options.cardProfileId ?? defaultCardProfileId;
  const registry = options.registry ?? defaultCardProfileRegistry;
  const profile = registry.get(cardProfileId);

  if (profile === undefined) {
    throw new UnknownCardProfileError(cardProfileId);
  }

  const parsed = profile.normalize(rawCard);

  return {
    capabilities: parsed.capabilities,
    cardProfileId,
    displayName: parsed.name,
    invocationEndpoint: parsed.invocationEndpoint,
    rawCard,
    summary: parsed.summary,
    tags: parsed.tags,
  };
}
