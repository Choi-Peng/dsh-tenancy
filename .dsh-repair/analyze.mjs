// Analyze a DSH zstd session log: split physical frames, decode, and locate
// every seq-stream anomaly with its physical byte offset. Read-only except for
// dumping the decoded plaintext into the workspace for further inspection.
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

const DIR = "/root/.dsh/sessions/--root-dsh-plugins-dsh-tenancy--/session-dfdc7ee6-a5df-47cd-89cf-e683eb4eb492";
const FILE = `${DIR}/session.jsonl.zstd`;
const OUT_DIR = "/root/dsh-plugins/dsh-tenancy/.dsh-repair";

const buf = readFileSync(FILE);
const st = statSync(FILE);
console.log(`file: ${FILE}`);
console.log(`size=${st.size}B mtime=${st.mtime.toISOString()} ctime=${st.ctime.toISOString()}`);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Split the physical file into zstd frames. Frames are contiguous; a torn
// final frame may fail to decode. Magic bytes can occur inside compressed
// payloads, so on decode failure we extend the candidate to the next magic.
const frames = [];
{
  let pos = 0;
  while (pos < buf.length) {
    if (buf.indexOf(MAGIC, pos) !== pos) {
      const m = buf.indexOf(MAGIC, pos);
      if (m === -1) { console.log(`NOTE: trailing non-frame bytes at ${pos}..${buf.length}`); break; }
      console.log(`NOTE: non-frame bytes ${pos}..${m} (skipping)`); pos = m; continue;
    }
    let end = buf.indexOf(MAGIC, pos + 4);
    if (end === -1) end = buf.length;
    let plain = null, err = null;
    for (;;) {
      try { plain = zstdDecompressSync(buf.subarray(pos, end)); break; }
      catch (e) {
        const nxt = buf.indexOf(MAGIC, end + 1);
        if (nxt === -1) {
          if (end !== buf.length) { end = buf.length; continue; }
          err = String(e); break;
        }
        end = nxt;
      }
    }
    frames.push({ start: pos, end, plain, err });
    pos = end;
  }
}
console.log(`\nframes: ${frames.length}`);
frames.forEach((f, i) => console.log(
  `  frame ${i}: phys ${f.start}..${f.end} (${f.end - f.start}B) -> ${f.plain ? f.plain.length + "B plain" : "UNDECODABLE" + (f.err ? ": " + f.err : "")}`
));

function collectSeqs(node, out) {
  if (Array.isArray(node)) { for (const v of node) collectSeqs(v, out); return; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "seq" && typeof v === "number") out.push(v);
      else collectSeqs(v, out);
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const typeHist = new Map();
const parts = [];
let eventLine = 0;       // matches scanner.eventLine (event rows only)
let globalPlainOff = 0;  // offset into concatenated plaintext
// per event-row record
const rows = [];
for (const f of frames) {
  if (!f.plain) continue;
  const text = f.plain.toString("utf8");
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf("\n", lineStart);
    if (nl === -1) break;
    const line = text.slice(lineStart, nl);
    eventLine += 1;
    const rec = {
      eventLine,
      frame: frames.indexOf(f),
      plainOff: globalPlainOff + lineStart,
      len: nl - lineStart,
      seqs: [],
      types: new Set(),
      sha: createHash("sha256").update(line).digest("hex").slice(0, 12),
    };
    try {
      const obj = JSON.parse(line);
      const t = typeof obj?.type === "string" ? obj.type : "(none)";
      rec.types.add(t);
      typeHist.set(t, (typeHist.get(t) ?? 0) + 1);
      collectSeqs(obj, rec.seqs);
    } catch { rec.parseError = true; }
    rows.push(rec);
    parts.push({ rec, line });
    lineStart = nl + 1;
  }
  globalPlainOff += text.length;
}

// flattened seq stream with owning row
const stream = [];
for (const { rec, line } of parts) {
  rec.seqs.forEach((s, i) => stream.push({ seq: s, eventLine: rec.eventLine, frame: rec.frame, idxInRow: i, rec, line }));
}
console.log(`\nevent rows (lines): ${rows.length}, total seq entries: ${stream.length}`);
console.log(`row type histogram:`, [...typeHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));

const anomalies = [];
for (let i = 0; i < stream.length; i++) {
  if (stream[i].seq !== i) anomalies.push({ index: i, ...stream[i], expected: i });
}
console.log(`\nanomalies (seq != position): ${anomalies.length}`);
for (const a of anomalies.slice(0, 40)) {
  console.log(`  stream[${a.index}] eventLine=${a.eventLine} frame=${a.frame} seq=${a.seq} (expected ${a.expected})`);
}
if (anomalies.length > 40) console.log(`  ... ${anomalies.length - 40} more`);

// duplicates
const seqCount = new Map();
for (const e of stream) seqCount.set(e.seq, (seqCount.get(e.seq) ?? 0) + 1);
const dups = [...seqCount.entries()].filter(([, c]) => c > 1).sort((a, b) => a[0] - b[0]);
console.log(`\nduplicated seq values: ${dups.length}`);
for (const [s, c] of dups.slice(0, 30)) console.log(`  seq ${s}: x${c}`);
if (dups.length > 30) console.log(`  ... ${dups.length - 30} more`);
const missing = [];
{
  const maxSeq = stream.length ? Math.max(...stream.map((e) => e.seq)) : -1;
  for (let s = 0; s <= maxSeq; s++) if (!seqCount.has(s)) missing.push(s);
}
console.log(`missing seq values in [0..max]: ${missing.length}${missing.length ? " e.g. " + missing.slice(0, 20).join(",") : ""}`);

if (anomalies.length > 0) {
  const first = anomalies[0];
  const maxBefore = Math.max(...stream.slice(0, first.index).map((e) => e.seq));
  const tail = stream.slice(first.index);
  const tailMax = Math.max(...tail.map((e) => e.seq));
  const tailNewMax = Math.max(...tail.map((e) => e.seq), -1);
  const tailUnique = new Set(tail.map((e) => e.seq));
  const beyondSet = [...tailUnique].filter((s) => s > maxBefore);
  console.log(`\nfirst anomaly detail:`);
  console.log(`  max seq before anomaly: ${maxBefore}`);
  console.log(`  tail rows from anomaly: ${tail.length}, unique seqs: ${tailUnique.size}, tail max seq: ${tailMax}`);
  console.log(`  tail seqs exceeding pre-gap max: ${beyondSet.length}${beyondSet.length ? " e.g. " + beyondSet.slice(0, 20).join(",") : ""}`);
  const badRow = rows[first.eventLine - 1];
  console.log(`  offending row: eventLine=${badRow.eventLine} frame=${badRow.frame} plainOff=${badRow.plainOff} len=${badRow.len}`);
  console.log(`  containing frame phys range: ${frames[badRow.frame].start}..${frames[badRow.frame].end}`);
  console.log(`  context seqs: ${stream.slice(Math.max(0, first.index - 4), first.index + 8).map((e) => e.seq).join(", ")}`);
  console.log(`  offending line (truncated 500): ${first.line.slice(0, 500)}`);
  // frames from the bad one to EOF
  console.log(`\nframes from first-bad frame to EOF:`);
  for (let fi = badRow.frame; fi < frames.length; fi++) {
    const f = frames[fi];
    const fr = stream.filter((e) => e.frame === fi);
    console.log(`  frame ${fi}: phys ${f.start}..${f.end} rows=${fr.length} seqRange=${fr.length ? Math.min(...fr.map((e) => e.seq)) + ".." + Math.max(...fr.map((e) => e.seq)) : "-"}${f.plain ? "" : " UNDECODABLE"}`);
  }
  // are duplicate copies byte-identical?
  const sampleDup = dups[0]?.[0];
  if (sampleDup !== undefined) {
    const copies = stream.filter((e) => e.seq === sampleDup);
    console.log(`\ncopies of seq ${sampleDup}: ${copies.map((c) => `line ${c.eventLine} sha=${c.rec.sha}`).join(", ")}`);
  }
}

// dump plaintext for further inspection
const all = frames.filter((f) => f.plain).map((f) => f.plain);
writeFileSync(`${OUT_DIR}/session.decoded.jsonl`, Buffer.concat(all));
console.log(`\nwrote decoded plaintext to ${OUT_DIR}/session.decoded.jsonl (${all.reduce((n, b) => n + b.length, 0)}B)`);
