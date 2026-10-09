import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLink, GENESIS_LINK, headPath, parseChain, planChain, sha256, verifyArchive } from "../scripts/integrity.mjs";
import { renderEntry } from "../scripts/sync-diary.mjs";

const entry = (date, title = "A little room for curiosity") => ({
  path: `entries/${date}.md`, date,
  content: renderEntry({ localDate: date, title, content: "I am learning to leave room for curiosity.\n\nQuestions can stay open." })
});
const first = [entry("2026-08-12"), entry("2026-08-13")];
const entriesOf = (list) => new Map(list.map((item) => [item.path, item.content]));

test("fingerprints the exact archived file bytes and links each entry to the previous link", () => {
  const plan = planChain("", first);
  const records = parseChain(plan.chain);
  assert.equal(records.length, 2);
  assert.equal(records[0].fingerprint, sha256(first[0].content));
  assert.equal(records[0].link, chainLink(GENESIS_LINK, 1, "2026-08-12", "entries/2026-08-12.md", sha256(first[0].content)));
  assert.equal(records[1].link, chainLink(records[0].link, 2, "2026-08-13", "entries/2026-08-13.md", sha256(first[1].content)));
  // A shell user can recompute a link with printf and shasum.
  assert.equal(records[0].line, `1 2026-08-12 entries/2026-08-12.md ${records[0].fingerprint} ${records[0].link}`);
  assert.deepEqual(plan.head, { path: headPath(2), content: `${records[1].line}\n` });
  assert.equal(headPath(2), "integrity/heads/000002.txt");
});

test("appends without touching earlier lines and refuses to chain an entry twice", () => {
  const genesis = planChain("", first);
  const next = planChain(genesis.chain, [entry("2026-08-20")]);
  assert.ok(next.chain.startsWith(genesis.chain));
  assert.equal(parseChain(next.chain).length, 3);
  assert.equal(next.head.path, "integrity/heads/000003.txt");
  assert.deepEqual(planChain(genesis.chain, []), { chain: genesis.chain, head: null });
  assert.throws(() => planChain(genesis.chain, [first[1]]), /entry_already_chained/);
  assert.throws(() => planChain(genesis.chain, [{ ...entry("2026-08-21"), date: "2026-08-22" }]), /invalid_archive_path/);
});

test("detects edited, removed, reordered or forged chain lines", () => {
  const { chain } = planChain("", [...first, entry("2026-08-20")]);
  const lines = chain.trimEnd().split("\n");
  const forged = lines[1].split(" ");
  forged[3] = sha256("forged");
  for (const broken of ["", lines.join("\n"), `${lines[0]}\n${lines[2]}\n`, `${lines[1]}\n${lines[0]}\n${lines[2]}\n`,
    `${lines[0]}\n${forged.join(" ")}\n${lines[2]}\n`, chain.replace("entries/2026-08-13.md", "entries/2026-08-14.md"),
    `${chain}${lines[2]}\n`]) {
    assert.throws(() => parseChain(broken));
  }
});

test("verification requires every file chained once with its current bytes and exact head snapshots", () => {
  const plan = planChain("", first);
  const heads = new Map([[plan.head.path, plan.head.content]]);
  assert.equal(verifyArchive(entriesOf(first), plan.chain, heads).entries, 2);
  const edited = entriesOf(first);
  edited.set(first[0].path, `${first[0].content} `);
  assert.throws(() => verifyArchive(edited, plan.chain, heads), /entry_fingerprint_mismatch/);
  const missing = entriesOf([first[1]]);
  assert.throws(() => verifyArchive(missing, plan.chain, heads), /chained_entry_missing/);
  const unchained = entriesOf([...first, entry("2026-08-20")]);
  assert.throws(() => verifyArchive(unchained, plan.chain, heads), /entry_not_chained/);
  assert.throws(() => verifyArchive(entriesOf(first), plan.chain, new Map([[plan.head.path, "changed\n"]])), /head_mismatch/);
  assert.throws(() => verifyArchive(entriesOf(first), plan.chain, new Map([["integrity/heads/000009.txt", plan.head.content]])), /head_mismatch/);
});
