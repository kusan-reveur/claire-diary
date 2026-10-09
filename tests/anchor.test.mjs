import { test } from "node:test";
import assert from "node:assert/strict";
import { ANCHORS_PATH, confirmBlock, EXPLORERS, planAnchors, validateAnchorChanges } from "../scripts/anchor.mjs";
import { planChain, sha256 } from "../scripts/integrity.mjs";
import { renderEntry } from "../scripts/sync-diary.mjs";

const HASH = "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319";
const ROOT = "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00";
const explorer = ({ tip = 358_400, root = ROOT, hash = HASH, down = null } = {}) => async (url, options) => {
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  if (down && url.startsWith(down)) throw new Error("offline");
  const path = url.replace(/^https:\/\/[^/]+\/api/, "");
  if (path === "/blocks/tip/height") return new Response(String(tip));
  if (path === "/block-height/358391") return new Response(hash);
  if (path === `/block/${hash}`) return Response.json({ id: hash, height: 358391, merkle_root: root, timestamp: 1432827678 });
  return new Response("not found", { status: 404 });
};

test("confirms a block only when two explorers agree and it is buried by six blocks", async () => {
  assert.deepEqual(await confirmBlock(358391, ROOT, explorer()),
    { height: 358391, blockHash: HASH, time: "2015-05-28T15:41:18.000Z" });
  assert.equal(await confirmBlock(358391, ROOT, explorer({ tip: 358_395 })), null);
  assert.equal(await confirmBlock(358391, ROOT, explorer({ down: EXPLORERS[1] })), null);
  const disagree = async (url, options) => url === `${EXPLORERS[1]}/block-height/358391`
    ? new Response("1".repeat(64)) : explorer()(url, options);
  assert.equal(await confirmBlock(358391, ROOT, disagree), null);
});

test("rejects a proof whose merkle root is not in the agreed block", async () => {
  await assert.rejects(confirmBlock(358391, "00".repeat(32), explorer()), /bitcoin_attestation_mismatch/);
  await assert.rejects(confirmBlock(0, ROOT, explorer()), /invalid_bitcoin_attestation/);
});

test("summarizes heads as pending until a matching proof is confirmed", async () => {
  const content = renderEntry({ localDate: "2026-08-12", title: "Title", content: "Twenty characters or more of prose." });
  const { chain, head } = planChain("", [{ path: "entries/2026-08-12.md", content, date: "2026-08-12" }]);
  const heads = new Map([[head.path, head.content]]);
  const proof = (bitcoin) => new Map([[`${head.path}.ots`, { digest: sha256(head.content), bitcoin, pending: [] }]]);
  const pending = JSON.parse(await planAnchors(chain, heads, new Map()));
  assert.deepEqual(pending.anchors.map((anchor) => [anchor.head, anchor.status]), [[1, "pending"]]);
  const confirmed = JSON.parse(await planAnchors(chain, heads, proof([{ height: 9, merkleRoot: ROOT }, { height: 7, merkleRoot: ROOT }]),
    async (height) => ({ height, blockHash: HASH, time: "2026-10-09T10:00:00.000Z" })));
  assert.deepEqual(confirmed.anchors[0].bitcoin, { height: 7, blockHash: HASH, time: "2026-10-09T10:00:00.000Z" });
  assert.equal(confirmed.anchors[0].status, "confirmed");
  await assert.rejects(planAnchors(chain, heads, new Map([[`${head.path}.ots`, { digest: sha256("other"), bitcoin: [], pending: [] }]])),
    /proof_digest_mismatch/);
});

test("commits only new proofs, upgrades of pending proofs and the summary", () => {
  const stamped = new Set(["integrity/heads/000002.txt.ots"]);
  const pending = new Set(["integrity/heads/000001.txt.ots"]);
  assert.doesNotThrow(() => validateAnchorChanges(
    `A\tintegrity/heads/000002.txt.ots\nM\tintegrity/heads/000001.txt.ots\nA\t${ANCHORS_PATH}`, { stamped, pending }));
  for (const diff of ["M\tintegrity/heads/000003.txt.ots", "A\tintegrity/heads/000001.txt.ots", "D\tintegrity/heads/000001.txt.ots",
    "M\tintegrity/chain.txt", "M\tentries/2026-08-12.md", "A\tintegrity/heads/000002.txt"]) {
    assert.throws(() => validateAnchorChanges(diff, { stamped, pending }), /unexpected_staged_change/);
  }
});
