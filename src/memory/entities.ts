export interface ExtractedEntity {
  name: string;
  type: "person" | "place" | "topic" | "organization" | "concept";
  context?: string;
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  summary: string;
}

export function extractEntitiesSimple(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  const personPatterns = [
    /(?:my\s+)?(?:friend|mom|dad|brother|sister|wife|husband|partner|boss|teacher|doctor|neighbor|colleague)\s+(\w+)/gi,
    /\b([A-Z][a-z]+)\s+(?:said|told|asked|wants|needs|likes|hates|loves|is|was|are|were|has|had|did|does)\b/g,
  ];

  for (const pattern of personPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        entities.push({ name, type: "person", context: match[0] });
      }
    }
  }

  return entities;
}

export function parseEntityResponse(response: string): EntityExtractionResult {
  try {
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch {
    return { entities: [], summary: "" };
  }
}
