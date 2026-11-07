/** The folder a build lands in is named for the thing being built, not for the whole sentence
 *  someone typed: "Build a scheduling website with a week view and a form…" is a scheduling
 *  website, and the rest of it is the specification that goes inside the folder. */
const NAME_FILLER = /^(with|that|which|for|using|and|or|of|to|in|on|at|by|as|my|your|our|the|a|an)$/;

export function projectNameFrom(text: string): string {
  const cleaned = text
    .replace(/^(build|create|make|code|write|setup|develop)\s+(me\s+)?(a\s+|an\s+)?/i, "")
    .replace(/^(simple|new|basic)\s+/i, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const kept: string[] = [];
  for (const word of cleaned.split(" ").filter(Boolean)) {
    if (NAME_FILLER.test(word)) { if (kept.length) break; continue; }
    kept.push(word);
    if (kept.length === 3) break;
  }

  return `calvras-${kept.join("-").slice(0, 24) || "workspace"}`;
}
