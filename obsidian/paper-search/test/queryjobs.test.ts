import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryJobs } from "../src/queryjobs.ts";
import { FakeClock, flushPromises } from "./fakes.ts";

function jobs(clock: FakeClock) {
  return new QueryJobs((fn, ms) => clock.setTimeout(fn, ms), (id) => clock.clearTimeout(id));
}

test("QJ1 a job runs after its delay, with a token that is still current", () => {
  const clock = new FakeClock();
  const q = jobs(clock);
  const token = q.restart();
  let ran = false;
  q.after(200, () => { ran = q.isCurrent(token); });
  clock.advance(199);
  assert.equal(ran, false);
  clock.advance(1);
  assert.equal(ran, true);
});

test("QJ2 a new query cancels the old query's pending jobs, even one that schedules nothing itself", () => {
  // The search modal's bug: below the semantic threshold nothing new was scheduled, so the old request stayed current.
  const clock = new FakeClock();
  const q = jobs(clock);
  q.restart();
  let ran = 0;
  q.after(200, () => { ran++; });
  q.after(200, () => { ran++; });
  q.restart();
  clock.advance(1000);
  assert.equal(ran, 0);
});

test("QJ3 work already in flight learns it is stale once the query changes", async () => {
  const clock = new FakeClock();
  const q = jobs(clock);
  const token = q.restart();
  let release!: () => void;
  const reply = new Promise<void>((r) => { release = r; });
  let applied: boolean | null = null;
  q.after(200, async () => {
    await reply;
    applied = q.isCurrent(token);
  });
  clock.advance(200);   // the request is out
  q.restart();          // the user typed on (or backspaced below the threshold)
  release();
  await flushPromises();
  assert.equal(applied, false);
});

test("QJ4 cancel (the list closed) stops pending jobs and makes in-flight ones stale", () => {
  const clock = new FakeClock();
  const q = jobs(clock);
  const token = q.restart();
  let ran = false;
  q.after(200, () => { ran = true; });
  q.cancel();
  clock.advance(1000);
  assert.equal(ran, false);
  assert.equal(q.isCurrent(token), false);
});
