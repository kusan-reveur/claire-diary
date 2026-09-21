import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyPlan, fetchPublicDiary, loadArchive, MAX_RESPONSE_BYTES, planSync, PUBLIC_DIARY_URL, renderEntry, validateStagedChanges } from "../scripts/sync-diary.mjs";

const readme = "# Diary\n\n<!-- diary-index:start -->\n<!-- diary-index:end -->\n\nKeep this text.\n";
const entry = (date = "2026-08-12", overrides = {}) => ({
  localDate: date, title: "A little room for curiosity", content: "I am learning to leave room for curiosity.\n\nQuestions can stay open.", ...overrides
});
const now = new Date("2026-09-21T06:00:00Z");

test("copies only canonical English fields exactly, with date-based paths and escaped index labels", () => {
  const original = entry("2026-09-20", { title: "Curiosity [today]", contentFr: "Never publish this translation", id: "Never publish identity metadata" });
  const plan = planSync({ diary: [original] }, new Map(), readme, now);
  assert.deepEqual(plan.additions, [{ path: "entries/2026-09-20.md", content: renderEntry(original), date: "2026-09-20" }]);
  assert.ok(plan.readme.includes("Curiosity \\[today\\]"));
  assert.ok(plan.readme.endsWith("Keep this text.\n"));
  assert.ok(!JSON.stringify(plan).includes("Never publish"));
});

test("preserves legacy filenames and is byte-identical and idempotent on rerun", () => {
  const old = entry();
  const existing = new Map([["entries/2026-08-12-original-title.md", renderEntry(old)]]);
  const plan = planSync({ diary: [entry("2026-09-20"), old] }, existing, readme, now);
  assert.equal(plan.additions.length, 1);
  assert.ok(plan.readme.includes("entries/2026-08-12-original-title.md"));
  for (const added of plan.additions) existing.set(added.path, added.content);
  const again = planSync({ diary: [entry("2026-09-20"), old] }, existing, plan.readme, now);
  assert.deepEqual(again.additions, []);
  assert.equal(again.readme, plan.readme);
});

test("rejects existing title or content changes, including whitespace, before planning publication", () => {
  const old = entry();
  const existing = new Map([["entries/2026-08-12.md", renderEntry(old)]]);
  for (const replacement of [{ ...old, title: "A replacement title" }, { ...old, content: old.content + " " }]) {
    assert.throws(() => planSync({ diary: [entry("2026-09-20"), replacement] }, existing, readme, now), /existing_entry_mismatch/);
  }
});

test("fails on malformed or empty feeds, duplicate dates, invalid paths and future dates", () => {
  const existing = new Map([["entries/2026-08-12.md", renderEntry(entry())]]);
  for (const profile of [null, {}, { diary: [] }, { diary: [entry(), entry()] },
    { diary: [entry("../../README")] }, { diary: [entry("2026-02-30")] },
    { diary: [entry("2099-01-01")] }, { diary: [entry(undefined, { title: "Line\nbreak" })] },
    { diary: [entry(undefined, { content: null })] }]) {
    assert.throws(() => planSync(profile, existing, readme, now));
  }
  assert.throws(() => planSync({ diary: [entry()] }, new Map([["../README.md", "escape"]]), readme, now), /invalid_archive_path/);
  assert.throws(() => planSync({ diary: [entry()] }, new Map(), "missing markers", now), /invalid_index_markers/);
});

test("requires window overlap if the public API returns its full 31-entry limit", () => {
  const diary = Array.from({ length: 31 }, (_, n) => entry(`2026-08-${String(n + 1).padStart(2, "0")}`));
  const old = entry("2026-07-27");
  assert.throws(() => planSync({ diary }, new Map([["entries/2026-07-27.md", renderEntry(old)]]), readme, now), /public_window_gap_requires_review/);
  assert.throws(() => planSync({ diary }, new Map(), readme, now), /public_window_gap_requires_review/);
  assert.equal(planSync({ diary }, new Map([["entries/2026-08-01.md", renderEntry(diary[0])]]), readme, now).additions.length, 30);
  // Old archive entries falling outside the public window are preserved, not deleted.
  assert.ok(planSync({ diary }, new Map([["entries/2026-07-27.md", renderEntry(old)], ["entries/2026-08-01.md", renderEntry(diary[0])]]), readme, now).readme.includes("2026-07-27.md"));
});

test("writes new files exclusively, preserves historical checksums, and refuses symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "diary-sync-test-"));
  await mkdir(join(root, "entries"));
  await writeFile(join(root, "README.md"), readme);
  const original = renderEntry(entry());
  await writeFile(join(root, "entries/2026-08-12.md"), original);
  const archive = await loadArchive(root);
  const plan = planSync({ diary: [entry("2026-09-20"), entry()] }, archive.existing, archive.readme, now);
  await applyPlan(root, plan);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(await readFile(join(root, "entries/2026-08-12.md"))), hash(original));
  assert.deepEqual((await readdir(join(root, "entries"))).sort(), ["2026-08-12.md", "2026-09-20.md"]);
  await assert.rejects(applyPlan(root, plan), { code: "EEXIST" });
  await symlink(join(root, "README.md"), join(root, "entries/2026-09-19.md"));
  await assert.rejects(loadArchive(root), /invalid_archive_file/);
});

test("allows only staged entry additions and the README index, never edits or deletions", () => {
  const additions = [{ path: "entries/2026-09-20.md" }];
  assert.doesNotThrow(() => validateStagedChanges("A\tentries/2026-09-20.md\nM\tREADME.md", additions));
  for (const diff of ["M\tentries/2026-09-20.md", "D\tentries/2026-08-12.md", "A\tsecrets.txt", "M\tREADME.md", "R100\told.md\tnew.md"]) {
    assert.throws(() => validateStagedChanges(diff, additions));
  }
});

test("fetches only the fixed public endpoint without credentials or redirects", async () => {
  const body = { diary: [entry()] };
  const result = await fetchPublicDiary(async (url, options) => {
    assert.equal(url, PUBLIC_DIARY_URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, { accept: "application/json" });
    return Response.json(body);
  });
  assert.deepEqual(result, body);
});

test("rejects errors, HTML, malformed JSON and oversized bodies without exposing their contents", async () => {
  for (const response of [new Response("private detail", { status: 503 }),
    new Response("private detail", { headers: { "content-type": "text/html" } }),
    new Response("private detail", { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(fetchPublicDiary(async () => response), (error) => !error.message.includes("private detail"));
  }
});
