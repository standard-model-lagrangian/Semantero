import test from "node:test";
import assert from "node:assert";
import { formatQuery, embedQuery, warmUp } from "../src/ollama.ts";

test("query is wrapped in the instruction format exactly", async () => {
  const instruction = "Given a description of what a paper found or showed, retrieve that paper";
  const query = "viscoelastic hydrogels";
  const formatted = formatQuery(instruction, query);
  assert.strictEqual(
    formatted,
    "Instruct: Given a description of what a paper found or showed, retrieve that paper\nQuery: viscoelastic hydrogels"
  );

  let capturedBody: any = null;
  const fakeRequestUrl = async (params: { url: string; body: string }) => {
    capturedBody = JSON.parse(params.body);
    return {
      status: 200,
      json: {
        embeddings: [[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]],
      },
    };
  };

  const vec = await embedQuery(fakeRequestUrl as any, {
    url: "http://127.0.0.1:11434",
    model: "qwen3-embedding:0.6b",
    instruction,
    query,
    dims: 8,
  });

  assert.strictEqual(capturedBody.input[0], formatted);
  assert.strictEqual(capturedBody.model, "qwen3-embedding:0.6b");
  assert.strictEqual(vec.length, 8);
});

test("warm-up request sends keep_alive and empty input", async () => {
  let capturedBody: any = null;
  const fakeRequestUrl = async (params: { url: string; body: string }) => {
    capturedBody = JSON.parse(params.body);
    return {
      status: 200,
      json: {},
    };
  };

  await warmUp(fakeRequestUrl as any, {
    url: "http://127.0.0.1:11434",
    model: "qwen3-embedding:0.6b",
    keepAlive: "30m",
  });

  assert.deepStrictEqual(capturedBody.input, [""]);
  assert.strictEqual(capturedBody.keep_alive, "30m");
  assert.strictEqual(capturedBody.model, "qwen3-embedding:0.6b");
});

test("keep_alive defaults to 5 minutes when not given (the model's process holds ~400 MB while loaded)", async () => {
  const { embedQuery, warmUp, DEFAULT_KEEP_ALIVE } = await import("../src/ollama.ts");
  const bodies: any[] = [];
  const fake = async (p: { body?: string }) => { bodies.push(JSON.parse(p.body!)); return { status: 200, json: { embeddings: [[1, 0]] } }; };
  await embedQuery(fake, { url: "http://x", model: "m", instruction: "i", query: "q" });
  await warmUp(fake, { url: "http://x", model: "m" });
  assert.strictEqual(DEFAULT_KEEP_ALIVE, "5m");
  assert.deepStrictEqual(bodies.map((b) => b.keep_alive), ["5m", "5m"]);
});

test("without an instruction the query is embedded as it is (eval-related --no-instruction), not as 'Instruct: undefined'", async () => {
  const bodies: { input: string[] }[] = [];
  const fake = async (p: { body?: string }) => {
    assert.ok(p.body);
    bodies.push(JSON.parse(p.body));
    return { status: 200, json: { embeddings: [[1, 0]] } };
  };
  await embedQuery(fake, { url: "http://x", model: "m", query: "viscoelastic hydrogels" });
  assert.deepStrictEqual(bodies[0].input, ["viscoelastic hydrogels"]);
  assert.strictEqual(formatQuery(undefined, "q"), "q");
});
