// Public integrity chain for Claire's diary. Every archived entry file gets a
// SHA-256 fingerprint, and each chain link hashes the previous link, so changing,
// removing, or reordering any past entry breaks every later link. Chain heads are
// timestamped in Bitcoin by scripts/anchor.mjs. Run this file to verify offline.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHAIN_PATH = "integrity/chain.txt";
export const HEADS_DIR = "integrity/heads";
export const GENESIS_LINK = "0".repeat(64);
const ENTRY_PATH = /^entries\/(\d{4}-\d{2}-\d{2})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;
const CHAIN_LINE = /^(\d+) (\d{4}-\d{2}-\d{2}) (\S+) ([0-9a-f]{64}) ([0-9a-f]{64})$/;
export const HEAD_FILE = /^integrity\/heads\/(\d{6})\.txt$/;

export class IntegrityError extends Error {}
function requireCondition(condition, code) {
  if (!condition) throw new IntegrityError(code);
}

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** One link: SHA-256 of "<previous link> <seq> <date> <file> <fingerprint>" (ASCII). */
export function chainLink(previous, seq, date, file, fingerprint) {
  return sha256(`${previous} ${seq} ${date} ${file} ${fingerprint}`);
}

export function headPath(seq) {
  return `${HEADS_DIR}/${String(seq).padStart(6, "0")}.txt`;
}

/** Parses and fully recomputes the chain; any edited, missing, or reordered line fails. */
export function parseChain(text) {
  requireCondition(typeof text === "string" && text.length > 0 && text.endsWith("\n"), "invalid_chain_file");
  const records = [];
  let previous = GENESIS_LINK;
  for (const line of text.slice(0, -1).split("\n")) {
    const match = CHAIN_LINE.exec(line);
    requireCondition(match, "invalid_chain_line");
    const [, seqText, date, file, fingerprint, link] = match;
    const seq = records.length + 1;
    requireCondition(seqText === String(seq), "chain_sequence_mismatch");
    const fileMatch = ENTRY_PATH.exec(file);
    requireCondition(fileMatch && fileMatch[1] === date, "invalid_chain_entry_path");
    requireCondition(link === chainLink(previous, seq, date, file, fingerprint), "chain_link_mismatch");
    records.push({ seq, date, file, fingerprint, link, line });
    previous = link;
  }
  return records;
}

/**
 * Appends additions (already sorted) after the existing chain; returns the new text and head.
 * An empty chain is only used once, by --genesis, to chain the entries published before it.
 */
export function planChain(chainText, additions) {
  const records = chainText === "" ? [] : parseChain(chainText);
  let text = chainText;
  let previous = records.at(-1)?.link ?? GENESIS_LINK;
  let last = null;
  for (const addition of additions) {
    const fileMatch = ENTRY_PATH.exec(addition.path);
    requireCondition(fileMatch && fileMatch[1] === addition.date, "invalid_archive_path");
    requireCondition(!records.some((record) => record.file === addition.path || record.date === addition.date), "entry_already_chained");
    const seq = records.length + 1;
    const fingerprint = sha256(addition.content);
    const link = chainLink(previous, seq, addition.date, addition.path, fingerprint);
    const line = `${seq} ${addition.date} ${addition.path} ${fingerprint} ${link}`;
    records.push({ seq, date: addition.date, file: addition.path, fingerprint, link, line });
    text += `${line}\n`;
    previous = link;
    last = records.at(-1);
  }
  return { chain: text, head: last ? { path: headPath(last.seq), content: `${last.line}\n` } : null };
}

/**
 * Verifies that every entry file is chained exactly once with its current bytes,
 * and that every head snapshot equals its chain line.
 */
export function verifyArchive(entries, chainText, heads) {
  const records = parseChain(chainText);
  const chained = new Set();
  const dates = new Set();
  for (const record of records) {
    requireCondition(entries.has(record.file), "chained_entry_missing");
    requireCondition(sha256(entries.get(record.file)) === record.fingerprint, "entry_fingerprint_mismatch");
    requireCondition(!chained.has(record.file) && !dates.has(record.date), "entry_chained_twice");
    chained.add(record.file);
    dates.add(record.date);
  }
  requireCondition([...entries.keys()].every((path) => chained.has(path)), "entry_not_chained");
  for (const [path, content] of heads) {
    const match = HEAD_FILE.exec(path);
    requireCondition(match, "invalid_head_path");
    const record = records[Number(match[1]) - 1];
    requireCondition(record && content === `${record.line}\n`, "head_mismatch");
  }
  return { entries: records.length, head: records.at(-1), heads: heads.size };
}

async function regularFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Reads the chain and head snapshots, refusing symlinks and unexpected files. */
export async function loadIntegrity(root) {
  requireCondition(await regularFile(resolve(root, CHAIN_PATH)), "missing_integrity_chain");
  requireCondition((await lstat(resolve(root, HEADS_DIR))).isDirectory(), "invalid_heads_directory");
  const heads = new Map();
  for (const file of await readdir(resolve(root, HEADS_DIR))) {
    const path = `${HEADS_DIR}/${file}`;
    if (/^\d{6}\.txt\.ots$/.test(file)) continue;
    requireCondition(HEAD_FILE.test(path) && await regularFile(resolve(root, path)), "invalid_head_file");
    heads.set(path, await readFile(resolve(root, path), "utf8"));
  }
  return { chain: await readFile(resolve(root, CHAIN_PATH), "utf8"), heads };
}

async function loadEntries(root) {
  const entries = new Map();
  for (const file of await readdir(resolve(root, "entries"))) {
    const path = `entries/${file}`;
    requireCondition(ENTRY_PATH.test(path) && await regularFile(resolve(root, path)), "invalid_archive_file");
    entries.set(path, await readFile(resolve(root, path), "utf8"));
  }
  return entries;
}

async function verifyRepository(root) {
  const integrity = await loadIntegrity(root);
  return verifyArchive(await loadEntries(root), integrity.chain, integrity.heads);
}

// One-time creation of the chain over the entries published before it existed.
async function createGenesis(root) {
  await mkdir(resolve(root, HEADS_DIR), { recursive: true });
  const additions = [...(await loadEntries(root))].map(([path, content]) => ({ path, content, date: ENTRY_PATH.exec(path)[1] }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const plan = planChain("", additions);
  await writeFile(resolve(root, CHAIN_PATH), plan.chain, { flag: "wx" });
  await writeFile(resolve(root, plan.head.path), plan.head.content, { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const genesis = process.argv[2] === "--genesis" ? createGenesis(root) : Promise.resolve();
  genesis.then(() => verifyRepository(root)).then((result) => {
    console.log(`OK: ${result.entries} entries, every fingerprint and link recomputed.`);
    console.log(`Chain head #${result.head.seq} (${result.head.date}): ${result.head.link}`);
    console.log(`${result.heads} head snapshot(s) match the chain. Check their Bitcoin proofs with: ots verify integrity/heads/<head>.txt.ots`);
  }).catch((error) => {
    console.error(error instanceof IntegrityError ? `FAILED: ${error.message}` : "FAILED: integrity_check_error");
    process.exitCode = 1;
  });
}
