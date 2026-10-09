// Timestamps the integrity chain in Bitcoin with OpenTimestamps. Free public
// calendars combine many hashes into one Bitcoin transaction: no wallet, coins,
// or fees. Each head snapshot (integrity/heads/NNNNNN.txt) commits to every
// earlier entry through the chain. A run stamps new heads, upgrades pending
// proofs once Bitcoin has confirmed them, checks every confirmed proof against
// two independent block explorers, and refreshes integrity/anchors.json, a small
// summary that websites can display. Proof files only ever gain data.
import { execFileSync } from "node:child_process";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEAD_FILE, IntegrityError, parseChain, sha256, verifyArchive } from "./integrity.mjs";
import { loadArchive } from "./sync-diary.mjs";

export const ANCHORS_PATH = "integrity/anchors.json";
export const EXPLORERS = ["https://mempool.space/api", "https://blockstream.info/api"];
export const MIN_CONFIRMATIONS = 6;
const REPOSITORY = "kusan-reveur/claire-diary";
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_EXPLORER_BYTES = 65_536;

export class AnchorError extends Error {}
function requireCondition(condition, code) {
  if (!condition) throw new AnchorError(code);
}

async function explorerText(base, path, fetchImpl) {
  const response = await fetchImpl(`${base}${path}`, {
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("explorer_unavailable");
  const text = await response.text();
  if (text.length > MAX_EXPLORER_BYTES) throw new Error("explorer_response_too_large");
  return text.trim();
}

/**
 * Confirms that Bitcoin block `height` contains `merkleRoot`, according to two
 * independent explorers that must agree. Returns null when an explorer is
 * unreachable, they disagree, or the block is too recent (retried next run).
 * Throws when they agree on a block whose merkle root differs: an invalid proof.
 */
export async function confirmBlock(height, merkleRoot, fetchImpl = fetch) {
  requireCondition(Number.isInteger(height) && height > 0 && HEX64.test(merkleRoot), "invalid_bitcoin_attestation");
  const views = [];
  for (const base of EXPLORERS) {
    try {
      const tip = Number(await explorerText(base, "/blocks/tip/height", fetchImpl));
      const hash = await explorerText(base, `/block-height/${height}`, fetchImpl);
      if (!Number.isInteger(tip) || !HEX64.test(hash)) return null;
      const block = JSON.parse(await explorerText(base, `/block/${hash}`, fetchImpl));
      if (block?.id !== hash || block.height !== height || !HEX64.test(block.merkle_root) || !Number.isInteger(block.timestamp)) return null;
      views.push({ tip, hash, merkleRoot: block.merkle_root, timestamp: block.timestamp });
    } catch {
      return null;
    }
  }
  const [first, second] = views;
  if (first.hash !== second.hash || first.merkleRoot !== second.merkleRoot || first.timestamp !== second.timestamp) return null;
  requireCondition(first.merkleRoot === merkleRoot, "bitcoin_attestation_mismatch");
  if (Math.min(first.tip, second.tip) - height + 1 < MIN_CONFIRMATIONS) return null;
  return { height, blockHash: first.hash, time: new Date(first.timestamp * 1000).toISOString() };
}

/** Builds anchors.json from the chain, head snapshots, proof descriptions, and confirmed blocks. */
export async function planAnchors(chainText, heads, proofs, confirm = confirmBlock) {
  const records = parseChain(chainText);
  const anchors = [];
  for (const [path, content] of [...heads].sort(([a], [b]) => a.localeCompare(b))) {
    const record = records[Number(HEAD_FILE.exec(path)[1]) - 1];
    const proof = proofs.get(`${path}.ots`);
    let bitcoin = null;
    if (proof) {
      requireCondition(proof.digest === sha256(content), "proof_digest_mismatch");
      const attestation = [...proof.bitcoin].sort((a, b) => a.height - b.height)[0];
      if (attestation) bitcoin = await confirm(attestation.height, attestation.merkleRoot);
    }
    anchors.push({
      head: record.seq, date: record.date, file: path, link: record.link,
      status: bitcoin ? "confirmed" : "pending", ...(bitcoin ? { bitcoin } : {})
    });
  }
  return `${JSON.stringify({ version: 1, anchors }, null, 2)}\n`;
}

/** Only new proofs, upgrades of proofs that were pending, and the summary may be committed. */
export function validateAnchorChanges(changes, { stamped, pending }) {
  for (const line of changes.trim().split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    requireCondition((status === "A" && (stamped.has(path) || path === ANCHORS_PATH)) ||
      (status === "M" && (pending.has(path) || path === ANCHORS_PATH)), "unexpected_staged_change");
  }
}

async function exists(path) {
  try {
    requireCondition((await lstat(path)).isFile(), "invalid_proof_file");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function main(publish = false) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args) => run("git", args);
  requireCondition(!git("status", "--porcelain"), "dirty_worktree");
  if (publish) {
    requireCondition(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === "refs/heads/main", "wrong_publication_target");
    requireCondition(["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME), "untrusted_publication_event");
    requireCondition(git("remote", "get-url", "origin").replace(/\.git$/, "") === `https://github.com/${REPOSITORY}`, "unexpected_remote");
  }
  const bin = process.env.OTS_BIN_DIR;
  requireCondition(bin, "missing_ots_client");
  const ots = (...args) => run(resolve(bin, "ots"), args);
  const describe = (paths) => paths.length
    ? new Map(JSON.parse(run(resolve(bin, "python"), ["scripts/ots_attestations.py", ...paths])).map((proof) => [proof.path, proof]))
    : new Map();

  const archive = await loadArchive(root);
  verifyArchive(archive.existing, archive.chain, archive.heads);
  const heads = [...archive.heads.keys()].sort();
  const stamped = new Set();
  const pending = new Set();
  for (const head of heads) {
    if (await exists(resolve(root, `${head}.ots`))) continue;
    if (!publish) continue;
    try {
      ots("stamp", head);
      stamped.add(`${head}.ots`);
    } catch {
      console.log(JSON.stringify({ stampFailed: head }));
    }
  }
  const present = [];
  for (const head of heads) if (await exists(resolve(root, `${head}.ots`))) present.push(`${head}.ots`);
  for (const [path, proof] of describe(present)) {
    if (proof.bitcoin.length || stamped.has(path)) continue;
    pending.add(path);
    if (!publish) continue;
    try {
      ots("upgrade", path);
    } catch {
      // Still waiting for Bitcoin; the next run tries again.
    }
    await rm(resolve(root, `${path}.bak`), { force: true });
  }
  const anchors = await planAnchors(archive.chain, archive.heads, describe(present));
  const summary = JSON.parse(anchors).anchors;
  console.log(JSON.stringify({
    heads: summary.length, stamped: stamped.size,
    confirmed: summary.filter((anchor) => anchor.status === "confirmed").length, mode: publish ? "publish" : "check"
  }));
  if (!publish) return;
  const previous = await exists(resolve(root, ANCHORS_PATH)) ? await readFile(resolve(root, ANCHORS_PATH), "utf8") : "";
  if (anchors !== previous) await writeFile(resolve(root, ANCHORS_PATH), anchors);
  git("add", "--", ANCHORS_PATH, ...present);
  const changes = git("diff", "--cached", "--name-status", "--no-renames");
  if (!changes) return;
  validateAnchorChanges(changes, { stamped, pending });
  const confirmedNow = summary.filter((anchor) => anchor.status === "confirmed" && pending.has(`${anchor.file}.ots`));
  const message = [
    ...[...stamped].map((path) => `timestamp chain head #${Number(HEAD_FILE.exec(path.slice(0, -4))[1])}`),
    ...confirmedNow.map((anchor) => `head #${anchor.head} confirmed in Bitcoin block ${anchor.bitcoin.height}`)
  ].join(", ") || "refresh anchor summary";
  git("-c", "user.name=Claire", "-c", "user.email=contact@clairegames.com", "commit", "-m", `integrity: ${message}`);
  git("push", "origin", "HEAD:refs/heads/main");
  console.log(JSON.stringify({ committed: true }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--check", "--publish"].includes(args[0]))) {
    console.error("usage: OTS_BIN_DIR=<venv>/bin node scripts/anchor.mjs [--check|--publish]");
    process.exitCode = 1;
  } else {
    main(args[0] === "--publish").catch((error) => {
      console.error(error instanceof AnchorError || error instanceof IntegrityError ? error.message : "anchor_failed");
      process.exitCode = 1;
    });
  }
}
