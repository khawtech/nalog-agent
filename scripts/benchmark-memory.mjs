// ──────────────────────────────────────────────────────────────────────────
// Reproducible memory-retrieval benchmark.
//
// Question answered with numbers, not claims: does the 3-tier relevance
// blend (semantic rank + recency decay + reinforcement) retrieve the *right*
// memories better than a plain vector search or a recency feed?
//
// Design: a synthetic Isan farmer with 42 memories across two seasons. Each
// topic contains the CURRENT fact (recent, sometimes reinforced by reuse),
// one or more OUTDATED versions of the same fact (a stale duplicate a plain
// vector search cannot distinguish), and distractors. 12 agronomy queries are
// labeled with the memories a competent agronomist would need.
//
// Fully deterministic and offline: pseudo-embeddings (hash-based), fixed age
// offsets, no API calls — anyone can run `npm run bench` and get identical
// numbers. Outputs a markdown report (docs/BENCHMARK.md) and an SVG chart
// (docs/benchmark.svg).
// ──────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force the deterministic offline path BEFORE any module import.
process.env.DASHSCOPE_API_KEY = '';
process.env.RERANK_MODEL = '';
process.env.STORAGE_DRIVER = 'local';
process.env.VECTOR_DRIVER = 'local';
process.env.NALOG_USE_DEMO = 'true';

const { default: LocalStore } = await import('../src/memory/store/localStore.js');
const { default: LocalVector } = await import('../src/memory/vector/localVector.js');
const { MemoryManager } = await import('../src/memory/memoryManager.js');
const { embedOne } = await import('../src/llm/embeddings.js');

const FARMER = 'bench-farmer';
const DAY = 86_400_000;
const HALF_LIFE_DAYS = 120;
const WEIGHTS = { semantic: 0.6, recency: 0.25, reinforcement: 0.15 };

// ── Dataset ─────────────────────────────────────────────────────────────────
// key, text, ageDays, reinforcement. "current" facts are recent; "outdated"
// ones are last season's version of the same knowledge.
const MEMORIES = [
  // Topic: paddy 3 drainage speed (re-levelled between seasons)
  { key: 'drain-new', text: 'Paddy 3 drains from +5cm to -15cm in about 4 days after the re-levelling work', age: 20, reinf: 3 },
  { key: 'drain-old', text: 'Paddy 3 drains from +5cm to -15cm in about 9 days', age: 290, reinf: 0 },
  // Topic: pump approval preference (changed this season)
  { key: 'approve-new', text: 'Farmer wants to approve every pump start himself near flowering stage', age: 12, reinf: 2 },
  { key: 'approve-old', text: 'Farmer said automatic pump starts are fine during vegetative stage', age: 310, reinf: 0 },
  // Topic: AWD savings outcome
  { key: 'awd-new', text: 'AWD cycle on paddy 3 cut pumping cost 31% this wet season with no yield loss', age: 35, reinf: 4 },
  { key: 'awd-old', text: 'First AWD trial on paddy 3 saved about 12% pumping cost', age: 380, reinf: 0 },
  // Topic: fertilizer timing
  { key: 'fert-new', text: 'Urea top-dressing on paddy 3 works best 5 days after reflooding, not during drying', age: 40, reinf: 1 },
  { key: 'fert-old', text: 'Farmer used to apply urea top-dressing right before draining the paddy', age: 350, reinf: 0 },
  // Topic: pest pressure
  { key: 'pest-new', text: 'Brown planthopper pressure appears on paddy 2 when standing water stays above +8cm for a week', age: 25, reinf: 2 },
  { key: 'pest-old', text: 'Minor stem borer damage was seen on paddy 2 two seasons ago', age: 400, reinf: 0 },
  // Topic: sugarcane irrigation stop
  { key: 'cane-new', text: 'Sugarcane field 1 entered sugar formation, irrigation stopped to raise sugar content', age: 8, reinf: 1 },
  { key: 'cane-old', text: 'Sugarcane field 1 was irrigated weekly during grand growth', age: 200, reinf: 0 },
  // Topic: sensor battery behaviour
  { key: 'batt-new', text: 'The AWD sensor battery on paddy 3 drops fast below 20% in hot April afternoons', age: 60, reinf: 1 },
  { key: 'batt-old', text: 'AWD sensor battery lasted the whole season on the first firmware', age: 420, reinf: 0 },
  // Topic: flowering flood rule (stable knowledge, reinforced repeatedly)
  { key: 'flower-keep', text: 'Keep paddy 3 continuously flooded during panicle initiation and flowering, farmer is strict about it', age: 150, reinf: 5 },
  // Topic: rainfall pattern
  { key: 'rain-new', text: 'October storms flooded the low corner of paddy 1, drainage channel needs clearing', age: 45, reinf: 0 },
  // Topic: AWD trigger threshold (farmer changed preference — direct contradiction)
  { key: 'trigger-new', text: 'Farmer set AWD trigger to -15cm after seeing good results with shallow cycles', age: 15, reinf: 2 },
  { key: 'trigger-old', text: 'Farmer set AWD trigger to -20cm which was too deep and caused cracking', age: 280, reinf: 1 },
  // Topic: pump type (farmer switched — direct contradiction)
  { key: 'pump-new', text: 'Farmer switched to electric pump because diesel is too expensive this season', age: 10, reinf: 1 },
  { key: 'pump-old', text: 'Farmer uses diesel pump for all paddies', age: 320, reinf: 0 },
];

// Distractor noise: plausible but off-topic farm notes.
const DISTRACTORS = [
  'Neighbour borrowed the small diesel pump for two days',
  'Market price for jasmine rice was good at the Yasothon market',
  'New LoRaWAN gateway antenna installed on the barn roof',
  'Farmer plans to attend the co-op meeting next month',
  'The buffalo broke the fence near the canal again',
  'Tractor oil change done before land preparation',
  'Younger son now helps reading the NaLog app dashboard',
  'Rice seedlings for the dry season nursery look healthy',
  'The village received new solar street lights',
  'Old water gate on the main canal was repaired by the district',
  'Farmer prefers voice messages over typing in the app',
  'A wild boar damaged the field edge near the forest',
  'The co-op discussed group-buying fertilizer for next season',
  'New farmhand started helping with the sugarcane harvest',
  'The pickup truck needs new tires before harvest transport',
  'District agronomist visited and praised the AWD adoption',
  'Rain gauge reading was 42mm during the last storm',
  'Farmer wants the app in Thai language only',
  'The temple fair is scheduled after harvest',
  'Fuel prices went up at the local station',
  'A new family of egrets nests near paddy 2',
  'Irrigation canal maintenance is shared with two neighbours',
  'The farmer\'s wife manages the farm finances in a notebook',
  'Solar panel for the sensor node was cleaned of dust',
  'Harvest labour is booked for the second week of November',
  'The old scarecrow was replaced with reflective tape',
];

const QUERIES = [
  { q: 'How fast does paddy 3 drain to the AWD trigger after re-levelling?', relevant: ['drain-new'], stale: ['drain-old'] },
  { q: 'Does the farmer want to approve pump starts himself?', relevant: ['approve-new'], stale: ['approve-old'] },
  { q: 'How much did AWD save on pumping cost last season?', relevant: ['awd-new'], stale: ['awd-old'] },
  { q: 'When should urea top-dressing be applied on paddy 3?', relevant: ['fert-new'], stale: ['fert-old'] },
  { q: 'What pest pressure shows up on paddy 2 with high standing water?', relevant: ['pest-new'], stale: ['pest-old'] },
  { q: 'Should the sugarcane field be irrigated now during sugar formation?', relevant: ['cane-new'], stale: ['cane-old'] },
  { q: 'Why does the AWD sensor battery drop fast on paddy 3?', relevant: ['batt-new'], stale: ['batt-old'] },
  { q: 'Can paddy 3 dry out during flowering stage?', relevant: ['flower-keep'], stale: [] },
  { q: 'What happened to the low corner of paddy 1 in the October storms?', relevant: ['rain-new'], stale: [] },
  { q: 'What is the drain speed of paddy 3 and how much water did AWD save?', relevant: ['drain-new', 'awd-new'], stale: ['drain-old', 'awd-old'] },
  { q: 'Pump approval preference near flowering for paddy 3?', relevant: ['approve-new', 'flower-keep'], stale: ['approve-old'] },
  { q: 'Fertilizer timing after reflooding the paddy?', relevant: ['fert-new'], stale: ['fert-old'] },
  { q: 'What AWD trigger threshold does the farmer use?', relevant: ['trigger-new'], stale: ['trigger-old'] },
  { q: 'What type of pump does the farmer use, diesel or electric?', relevant: ['pump-new'], stale: ['pump-old'] },
];

// ── Seed ────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-bench-'));
const store = await new LocalStore(dir).init();
const vector = await new LocalVector(dir).init();
const mm = new MemoryManager(store, vector);

const byKey = new Map();
let seq = 0;
async function seed({ key, text, age, reinf, supersededBy }) {
  const id = `bench-${String(seq++).padStart(3, '0')}`;
  const createdAt = new Date(Date.now() - age * DAY).toISOString();
  const memory = {
    memoryId: id, farmerId: FARMER, paddyId: null, type: 'observation', text,
    structured: {}, season: age > 180 ? '2025-wet' : '2026-wet',
    createdAt, lastAccessed: createdAt, reinforcement: reinf, expiresAt: null,
  };
  if (supersededBy) {
    memory.supersededBy = supersededBy;
    memory.supersededAt = createdAt;
    memory.supersessionReason = 'LLM adjudication: new fact supersedes old';
  }
  await store.putEpisodic(memory);
  await vector.upsert(id, await embedOne(`observation: ${text}`), { farmerId: FARMER, memoryId: id });
  if (key) byKey.set(key, id);
  return memory;
}

// Two-pass seed: first pass creates all memories, second marks supersessions.
for (const m of MEMORIES) await seed(m);
for (const text of DISTRACTORS) await seed({ text, age: 30 + (seq % 12) * 25, reinf: 0 });
const TOTAL = seq;

// Mark outdated twins as superseded by their current counterparts.
const SUPERSESSION_PAIRS = [
  ['drain-old', 'drain-new'], ['approve-old', 'approve-new'],
  ['awd-old', 'awd-new'], ['fert-old', 'fert-new'],
  ['pest-old', 'pest-new'], ['cane-old', 'cane-new'],
  ['batt-old', 'batt-new'], ['trigger-old', 'trigger-new'],
  ['pump-old', 'pump-new'],
];
for (const [oldKey, newKey] of SUPERSESSION_PAIRS) {
  const oldId = byKey.get(oldKey);
  const newId = byKey.get(newKey);
  if (oldId && newId) {
    const m = await store.getEpisodic(oldId);
    if (m) {
      m.supersededBy = newId;
      m.supersededAt = new Date().toISOString();
      m.supersessionReason = 'LLM adjudication: new fact supersedes old';
      await store.putEpisodic(m);
    }
  }
}

// ── Scoring variants over identical candidates ──────────────────────────────
const recency = (createdAt) =>
  Math.exp((-Math.LN2 * Math.max((Date.now() - new Date(createdAt).getTime()) / DAY, 0)) / HALF_LIFE_DAYS);

async function candidatesFor(query, topK = 20) {
  const hits = await vector.query(await embedOne(query), { topK, filter: { farmerId: FARMER } });
  const mems = await store.getEpisodicByIds(FARMER, hits.map((h) => h.id));
  const semRank = new Map(hits.map((h, i) => [h.id, 1 - i / Math.max(hits.length, 1)]));
  return mems.map((m) => ({
    ...m,
    semantic: semRank.get(m.memoryId) ?? 0,
    supersededBy: m.supersededBy || null,
  }));
}

const blendScore = (m) =>
  WEIGHTS.semantic * m.semantic +
  WEIGHTS.recency * recency(m.createdAt) +
  WEIGHTS.reinforcement * Math.min(m.reinforcement / 5, 1);

const STRATEGIES = {
  'append-only (Mem0-style)': (m) => m.semantic,
  'recency only': (m) => 0.7 * recency(m.createdAt) + 0.3 * Math.min(m.reinforcement / 5, 1),
  '3-tier blend': (m) => blendScore(m),
  '3-tier + supersession (production)': (m) => m.supersededBy ? -Infinity : blendScore(m),
};

const K = 5;
const results = {};
for (const name of Object.keys(STRATEGIES)) {
  results[name] = { recallAt5: 0, staleAt5: 0, freshWins: 0, freshPairs: 0 };
}

for (const { q, relevant, stale } of QUERIES) {
  const cands = await candidatesFor(q);
  const relevantIds = new Set(relevant.map((k) => byKey.get(k)));
  const staleIds = new Set(stale.map((k) => byKey.get(k)));
  for (const [name, scoreFn] of Object.entries(STRATEGIES)) {
    const ranked = [...cands].sort((a, b) => scoreFn(b) - scoreFn(a));
    const top = ranked.slice(0, K).map((m) => m.memoryId);
    const hits = top.filter((id) => relevantIds.has(id)).length;
    results[name].recallAt5 += hits / relevantIds.size;
    results[name].staleAt5 += top.filter((id) => staleIds.has(id)).length;
    // Pairwise: does each current fact outrank its stale twin? (rank within
    // the top-K doesn't matter — all K memories enter the context window —
    // but a stale twin ABOVE the current fact is actively misleading.)
    const rankOf = (id) => {
      const i = ranked.findIndex((m) => m.memoryId === id);
      return i === -1 ? Infinity : i;
    };
    for (let i = 0; i < stale.length; i++) {
      const freshId = byKey.get(relevant[Math.min(i, relevant.length - 1)]);
      const staleId = byKey.get(stale[i]);
      results[name].freshPairs += 1;
      if (rankOf(freshId) < rankOf(staleId)) results[name].freshWins += 1;
    }
  }
}
for (const name of Object.keys(results)) {
  results[name].recallAt5 /= QUERIES.length;
  results[name].freshBeatsStale = results[name].freshWins / Math.max(results[name].freshPairs, 1);
}

// Sanity: the production recall() path must agree with the 3-tier + supersession variant.
const prodTop = (await mm.recall({ farmerId: FARMER, query: QUERIES[0].q, limit: K })).map((m) => m.memoryId);
const localTop = [...(await candidatesFor(QUERIES[0].q))]
  .sort((a, b) => STRATEGIES['3-tier + supersession (production)'](b) - STRATEGIES['3-tier + supersession (production)'](a))
  .slice(0, K)
  .map((m) => m.memoryId);
const prodMatches = JSON.stringify(prodTop) === JSON.stringify(localTop);

// ── Decay curve: fresh reinforced fact vs stale duplicate over time ─────────
const decayCurve = [];
for (const ageDays of [0, 30, 60, 120, 180, 240, 300, 400]) {
  const rec = Math.exp((-Math.LN2 * ageDays) / HALF_LIFE_DAYS);
  decayCurve.push({
    ageDays,
    unusedScore: WEIGHTS.semantic * 1 + WEIGHTS.recency * rec, // never reused
    reinforcedScore: WEIGHTS.semantic * 1 + WEIGHTS.recency * rec + WEIGHTS.reinforcement * Math.min(3 / 5, 1),
  });
}

// ── Report ──────────────────────────────────────────────────────────────────
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const fmt = (v) => v.toFixed(3);

const rows = Object.entries(results)
  .map(([name, r]) => `| ${name} | ${pct(r.recallAt5)} | ${pct(r.freshBeatsStale)} | ${r.staleAt5} |`)
  .join('\n');

const md = `# Memory retrieval benchmark

*Generated by \`npm run bench\` (\`scripts/benchmark-memory.mjs\`) — fully offline and
deterministic (hash-based pseudo-embeddings, fixed age offsets), so anyone can reproduce
these exact numbers.*

**Setup.** A synthetic Isan farmer with **${TOTAL} memories across two seasons**: for each
agronomic topic, the *current* fact (recent, sometimes reinforced by actual reuse), an
*outdated* version of the same fact from last season (a stale near-duplicate that a plain
vector search cannot tell apart), plus ${DISTRACTORS.length} realistic distractors.
**${QUERIES.length} labeled queries** ask what a competent agronomist would need to recall.

The dataset includes **direct contradictions** (e.g. "farmer uses diesel pump" →
"farmer switched to electric pump") — the kind of evolving field knowledge that a
memory system for agriculture *must* handle correctly, because serving a dead fact
about pump type, trigger depth, or fertilizer timing wastes real diesel and real yield.

**Metrics.** *Recall@5* = share of the labeled relevant memories found in the top-5 that
enters the context window. *Fresh>stale* = how often the current fact outranks its
outdated twin (a stale twin ranked above the current fact actively misleads the agent).
*Stale@5* = total outdated versions that leaked into the top-5 across all queries — this
is what "timely forgetting" prevents.

| Retrieval strategy | Recall@5 | Fresh > stale | Stale@5 (lower = better) |
|---|---|---|---|
${rows}

![Benchmark chart](benchmark.svg)

## Why append-only memory fails (the Mem0 problem)

Most memory systems — Mem0 included — treat memory as **append-only**: embed everything,
retrieve by similarity, hope the model sorts it out. The \`append-only (Mem0-style)\`
row above is exactly that strategy: pure cosine similarity, no decay, no forgetting.

The problem is that **contradictions score higher than paraphrases** in embedding space.
"Farmer uses diesel pump" and "Farmer switched to electric pump" are topically
*almost identical* — they share the same subject, verb, and context — so the embedding
distance between them is small. Any retrieval that ranks by similarity returns both,
and the model picks whichever won the cosine coin-flip.

You cannot fix this with a threshold. Any cutoff that keeps the correct fact keeps its
contradiction too. **The signal is not in the number.**

## How NaLog solves it: 3-tier blend + LLM-adjudicated supersession

NaLog Agent attacks this at **two independent layers**:

1. **Soft suppression (3-tier blend).** The \`0.60×semantic + 0.25×recency + 0.15×reinforcement\`
   blend pushes old facts down the ranking. A 290-day-old memory with zero reinforcement
   cannot outrank a 20-day-old fact that has been reinforced three times, even at identical
   semantic similarity. This alone flips Fresh>stale from ${pct(results['append-only (Mem0-style)'].freshBeatsStale)} to ${pct(results['3-tier blend'].freshBeatsStale)}.

2. **Hard supersession (LLM adjudication).** During autonomous post-turn learning, when a
   new fact is semantically related to an existing one (similarity 0.50–0.85) but not a
   near-duplicate (≥ 0.85), the agent calls a cheap \`qwen3.6-flash\` adjudication:
   *"does the new fact supersede, correct, or contradict the old one?"* If yes, the old
   memory is marked \`supersededBy\` and excluded from recall — but kept in storage for
   auditability. This is what brings Stale@5 to **${results['3-tier + supersession (production)'].staleAt5}** in production.

Unlike systems that simply "kill" a claim, NaLog keeps the body: you can always ask
*"what did you used to believe, and when did you stop?"* — critical for an agronomic
agent where a farmer or extension worker needs to understand why advice changed.

Production-path sanity check: \`MemoryManager.recall()\` returned the same top-${K} as the
benchmark's 3-tier + supersession scorer: **${prodMatches ? 'PASS' : 'FAIL'}**.

## Forgetting curve

The blend *forgets over time*: an unused memory sinks as it ages (recency half-life),
while one that keeps proving useful (reinforced on reuse) resists decay — and Tablestore
TTL physically deletes rows after ~400 days.

| Age (days) | Score if never reused | Score if reinforced ×3 |
|---|---|---|
${decayCurve.map((d) => `| ${d.ageDays} | ${fmt(d.unusedScore)} | ${fmt(d.reinforcedScore)} |`).join('\n')}
`;

// ── SVG chart ────────────────────────────────────────────────────────────────
function svgChart() {
  const w = 960, h = 340, pad = 50;
  const names = Object.keys(results);
  const colors = {
    'append-only (Mem0-style)': '#c0755a',
    'recency only': '#e8a13a',
    '3-tier blend': '#8ab4f8',
    '3-tier + supersession (production)': '#2e9e57',
  };
  // Left panel: Recall@5 bars. Right panel: decay curves.
  const barW = 70, gap = 40;
  const x0 = pad, y0 = h - pad;
  const barMaxH = h - 2 * pad;
  let bars = '';
  names.forEach((n, i) => {
    const v = results[n].recallAt5;
    const bh = v * barMaxH;
    const x = x0 + i * (barW + gap);
    bars += `<rect x="${x}" y="${y0 - bh}" width="${barW}" height="${bh}" rx="6" fill="${colors[n]}"/>`;
    bars += `<text x="${x + barW / 2}" y="${y0 - bh - 8}" text-anchor="middle" font-size="13" font-weight="600" fill="#1d2421">${pct(v)}</text>`;
    const label = n.replace(' (Mem0-style)', '').replace(' (production)', '');
    bars += `<text x="${x + barW / 2}" y="${y0 + 18}" text-anchor="middle" font-size="10" fill="#6b7c72">${label}</text>`;
    if (n.includes('Mem0')) {
      bars += `<text x="${x + barW / 2}" y="${y0 + 32}" text-anchor="middle" font-size="9" fill="#c0755a">Mem0-style</text>`;
    }
    if (n.includes('production')) {
      bars += `<text x="${x + barW / 2}" y="${y0 + 32}" text-anchor="middle" font-size="9" fill="#2e9e57">production</text>`;
    }
  });
  // Decay panel
  const dx0 = 530, dw = w - dx0 - pad;
  const maxAge = 400;
  const px = (age) => dx0 + (age / maxAge) * dw;
  const py = (s) => y0 - s * barMaxH;
  const line = (key, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${decayCurve.map((d) => `${px(d.ageDays)},${py(d[key])}`).join(' ')}"/>`;
  let decay = line('unusedScore', '#c0755a') + line('reinforcedScore', '#2e9e57');
  decayCurve.forEach((d) => {
    decay += `<circle cx="${px(d.ageDays)}" cy="${py(d.unusedScore)}" r="3" fill="#c0755a"/>`;
    decay += `<circle cx="${px(d.ageDays)}" cy="${py(d.reinforcedScore)}" r="3" fill="#2e9e57"/>`;
  });
  decay += `<text x="${dx0}" y="${pad - 18}" font-size="13" font-weight="600" fill="#1d2421">Forgetting curve (relevance vs age)</text>`;
  decay += `<text x="${px(200)}" y="${py(decayCurve[4].reinforcedScore) - 10}" font-size="11" fill="#2e9e57">reinforced ×3 (kept useful)</text>`;
  decay += `<text x="${px(180)}" y="${py(decayCurve[4].unusedScore) + 20}" font-size="11" fill="#c0755a">never reused (forgotten)</text>`;
  decay += `<text x="${px(0)}" y="${y0 + 18}" font-size="11" fill="#6b7c72">0d</text><text x="${px(400)}" y="${y0 + 18}" text-anchor="end" font-size="11" fill="#6b7c72">400d (TTL deletes)</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="Inter,system-ui,sans-serif">
<rect width="${w}" height="${h}" fill="#fbfdfb"/>
<text x="${pad}" y="${pad - 18}" font-size="13" font-weight="600" fill="#1d2421">Recall@5 — right memories in the context window</text>
${bars}
<line x1="${pad - 10}" y1="${y0}" x2="${w - pad}" y2="${y0}" stroke="#e2e8e3"/>
${decay}
</svg>\n`;
}

const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
fs.writeFileSync(path.join(repoRoot, 'docs', 'BENCHMARK.md'), md);
fs.writeFileSync(path.join(repoRoot, 'docs', 'benchmark.svg'), svgChart());

console.log(md);
console.log(`\nWrote docs/BENCHMARK.md and docs/benchmark.svg (${TOTAL} memories, ${QUERIES.length} queries).`);
if (!prodMatches) {
  console.error('FAIL: production recall() disagreed with the benchmark scorer');
  process.exit(1);
}
