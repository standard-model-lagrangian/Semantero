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
