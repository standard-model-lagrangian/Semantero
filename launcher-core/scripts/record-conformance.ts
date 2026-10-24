// Records conformance/cases.json from the TypeScript implementation. Every ranker (JavaScriptCore,
// JSC + Accelerate, or a Swift port) must reproduce these view models exactly.
// Re-recording is a deliberate commit:  npm run record
process.env.TZ = "UTC"; // note dates are shown in the machine's time zone; the cases are recorded in UTC

import fs from "node:fs";
import path from "node:path";
import { fakeVec, fixtureEngine } from "../test/helpers.ts";

const KEYWORD_QUERIES = [
  "organoid", "organoids hydro", "viscoel", "stress relaxation", "roth", "matrigel", "batch to batch similarity",
  "stiffer gels", "chemoresist", "ehs", "IL-6 3D", "wang zhang", "Tue 20 Oct", "café stress", "crosslinking reproducible",
  "my thoughts on stress relaxation", "replication of the viscoelastic hydrogel", "the of and", "bifurcation",
];
const HYBRID_QUERIES = [
  "stress relaxation neurons", "organoid growth matrix degradation", "matrigel batch variation",
  "cell viscoelasticity continuum", "hydrogel experiment replication", "faster maturation of neurons",
  "stiffness chemoresistance integrin", "swiss charity update",
];
const SCOPES = ["all", "papers", "notes"] as const;

const e = fixtureEngine();
const cases: any[] = [];
for (const q of KEYWORD_QUERIES)
  for (const scope of SCOPES)
    cases.push({ name: `keyword ${scope}: ${q}`, mode: "keyword", query: q, scope, limit: 8, expect: e.keyword(q, scope, 8) });
for (const q of HYBRID_QUERIES) {
  const v = fakeVec(q);
  for (const scope of SCOPES)
    cases.push({ name: `hybrid ${scope}: ${q}`, mode: "hybrid", query: q, scope, limit: 6, qVec: Array.from(v), expect: e.hybrid(q, v, scope, 6) });
}
// A trailing space (or doubled spaces) must not change anything: these expect the results of the plain query.
for (const q of ["viscoel", "stiffer gels", "IL-6 3D", "roth"])
  cases.push({ name: `keyword all: ${q} + trailing space`, mode: "keyword", query: q.replace(/ /g, "  ") + " ", scope: "all", limit: 8, expect: e.keyword(q, "all", 8) });
{
  const q = "stress relaxation neurons", v = fakeVec(q);
  cases.push({ name: `hybrid all: ${q} + trailing space`, mode: "hybrid", query: q + " ", scope: "all", limit: 6, qVec: Array.from(v), expect: e.hybrid(q, v, "all", 6) });
}
cases.push({ name: "recent 5", mode: "recent", query: "", scope: "all", limit: 5, expect: e.recent(5) });
cases.push({ name: "empty query = recent", mode: "keyword", query: "", scope: "all", limit: 15, expect: e.keyword("", "all", 15) });
cases.push({ name: "limit 1", mode: "keyword", query: "organoid", scope: "all", limit: 1, expect: e.keyword("organoid", "all", 1) });

const out = path.resolve(import.meta.dirname, "../conformance/cases.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ tz: "UTC", dims: 8, cases }, null, 1) + "\n");
console.log(`recorded ${cases.length} cases → ${out}`);
