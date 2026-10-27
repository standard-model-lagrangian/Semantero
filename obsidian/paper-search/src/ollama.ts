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
  /** Omitted: the query is embedded as it is (as the planner embeds documents). */
  instruction?: string;
  query: string;
  keepAlive?: string;
  dims?: number;
}

export interface WarmUpOptions {
  url: string;
  model: string;
  keepAlive?: string;
}

/** How long Ollama keeps the embedding model loaded after a request. Its process holds ~400 MB while loaded; the
 * pop-up warms the model when it opens, so a short hold costs little. */
export const DEFAULT_KEEP_ALIVE = "5m";

export function formatQuery(instruction: string | undefined, query: string): string {
  return instruction === undefined ? query : `Instruct: ${instruction}\nQuery: ${query}`;
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
    keep_alive: options.keepAlive ?? DEFAULT_KEEP_ALIVE,
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
    keep_alive: options.keepAlive ?? DEFAULT_KEEP_ALIVE,
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
