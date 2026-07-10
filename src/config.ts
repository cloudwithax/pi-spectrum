export interface Config {
  mode: "spectrum" | "terminal";
  spectrum?: {
    projectId: string;
    projectSecret: string;
    webhookSecret?: string;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  workingDirectory: string;
}

export function loadConfig(): Config {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  const webhookSecret = process.env.SPECTRUM_WEBHOOK_SECRET;
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || "mimo-v2.5";
  const workingDirectory = process.env.WORKING_DIRECTORY || process.cwd();
  const mode: "spectrum" | "terminal" = process.env.MODE === "spectrum" && projectId && projectSecret ? "spectrum" : "terminal";

  if (!baseUrl) throw new Error("LLM_BASE_URL is required");
  if (!apiKey) throw new Error("LLM_API_KEY is required");

  if (mode === "spectrum") {
    if (!projectId) throw new Error("SPECTRUM_PROJECT_ID is required for spectrum mode");
    if (!projectSecret) throw new Error("SPECTRUM_PROJECT_SECRET is required for spectrum mode");
  }

  return {
    mode,
    spectrum: mode === "spectrum" ? { projectId: projectId!, projectSecret: projectSecret!, webhookSecret } : undefined,
    llm: { baseUrl, apiKey, model },
    workingDirectory,
  };
}
