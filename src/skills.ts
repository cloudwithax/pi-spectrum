import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.ts";

const SKILLS_DIR = path.join(process.cwd(), "skills");
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS_PER_SKILL = 8000;

export interface Skill {
  name: string;
  content: string;
}

export function loadSkills(): Skill[] {
  let files: string[];
  try {
    files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(SKILLS_DIR, f), "utf-8").trim();
      if (content) skills.push({ name: f.replace(/\.md$/, ""), content });
    } catch (e) {
      logger.warn("Failed to read skill file", { file: f, error: String(e) });
    }
  }
  return skills;
}

function deriveName(url: string, content: string): string {
  // Prefer a frontmatter/heading name, fall back to the URL.
  const fm = content.match(/^name:\s*(.+)$/m);
  const heading = content.match(/^#\s+(.+)$/m);
  const raw =
    fm?.[1]?.trim() ||
    heading?.[1]?.trim() ||
    new URL(url).hostname.split(".")[0];
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "skill";
}

export async function installSkillFromUrl(url: string): Promise<Skill> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (/image|video|audio|octet-stream/.test(contentType)) {
    throw new Error(`Not a text document (content-type: ${contentType})`);
  }

  const content = (await res.text()).trim();
  if (!content) throw new Error("Fetched document is empty");
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) {
    throw new Error(`Skill too large (max ${MAX_SKILL_BYTES / 1024}KB)`);
  }

  const name = deriveName(url, content);
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const file = path.join(SKILLS_DIR, `${name}.md`);
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, content, "utf-8");
  logger.info(existed ? "SKILL_UPDATED" : "SKILL_INSTALLED", { name, url, bytes: Buffer.byteLength(content) });
  return { name, content };
}

export function saveSkill(name: string, content: string): Skill {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) throw new Error("Invalid skill name");
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Skill content is empty");
  if (Buffer.byteLength(trimmed) > MAX_SKILL_BYTES) {
    throw new Error(`Skill too large (max ${MAX_SKILL_BYTES / 1024}KB)`);
  }
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const file = path.join(SKILLS_DIR, `${slug}.md`);
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, trimmed, "utf-8");
  logger.info(existed ? "SKILL_UPDATED" : "SKILL_CREATED", { name: slug, bytes: Buffer.byteLength(trimmed) });
  return { name: slug, content: trimmed };
}

export function removeSkill(name: string): boolean {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const file = path.join(SKILLS_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  logger.info("SKILL_REMOVED", { name: slug });
  return true;
}

export function buildSkillsPrompt(): string {
  const skills = loadSkills();
  if (skills.length === 0) return "";
  const parts = skills.map((s) => {
    const body = s.content.length > MAX_PROMPT_CHARS_PER_SKILL ? s.content.slice(0, MAX_PROMPT_CHARS_PER_SKILL) + "\n[...truncated]" : s.content;
    return `### Skill: ${s.name}\n${body}`;
  });
  return `\n\nINSTALLED SKILLS:\nThe user has installed the following skills. Follow their instructions when relevant.\n\n${parts.join("\n\n")}`;
}
