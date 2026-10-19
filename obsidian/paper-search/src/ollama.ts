import { truncateAndNormalize } from "./vectors.ts";

export type RequestUrlFn = (params: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json: any }>;

export interface EmbedQueryOptions {
  url: string;
  model: string;
  instruction: string;
  query: string;
  keepAlive?: string;
  dims?: number;
}

export interface WarmUpOptions {
  url: string;
  model: string;
  keepAlive?: string;
}

export function formatQuery(instruction: string, query: string): string {
  return `Instruct: ${instruction}\nQuery: ${query}`;
}

export async function embedQuery(
  requestUrl: RequestUrlFn,
  options: EmbedQueryOptions
): Promise<Float32Array> {
  const formattedInput = formatQuery(options.instruction, options.query);
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/embed`;

  const payload = {
    model: options.model,
    input: [formattedInput],
    keep_alive: options.keepAlive ?? "30m",
    truncate: true,
  };

  const resp = await requestUrl({
    url: endpoint,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const embeddings = resp.json?.embeddings;
  if (!embeddings || embeddings.length === 0) {
    throw new Error("No embeddings returned by Ollama");
  }

  const rawVec: number[] = embeddings[0];
  const dims = options.dims ?? rawVec.length;
  return truncateAndNormalize(rawVec, dims);
}

export async function warmUp(
  requestUrl: RequestUrlFn,
  options: WarmUpOptions
): Promise<void> {
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/embed`;
  const payload = {
    model: options.model,
    input: [""],
    keep_alive: options.keepAlive ?? "30m",
  };

  try {
    await requestUrl({
      url: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // warm-up failure is non-blocking
  }
}
