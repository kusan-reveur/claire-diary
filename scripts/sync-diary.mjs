import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_DIARY_URL = "https://bonjourclaire.com/api/claire/public";
export const MAX_RESPONSE_BYTES = 1_048_576;
const REPOSITORY = "kusan-reveur/claire-diary";
const START = "<!-- diary-index:start -->";
const END = "<!-- diary-index:end -->";
const ENTRY_PATH = /^entries\/(\d{4}-\d{2}-\d{2})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.md$/;

class SyncError extends Error {}
function requireCondition(condition, code) {
  if (!condition) throw new SyncError(code);
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function markdownLabel(value) {
  return value.replace(/[\\`*_{}[\]<>()!|]/g, "\\$&");
}
export function renderEntry(entry) {
  return `# ${entry.title}\n\n**Claire's diary — ${entry.localDate}**\n\n${entry.content}\n`;
}

// Pure planning: validate the entire response/archive before writing anything.
export function planSync(profile, existing, readme, now = new Date()) {
  requireCondition(profile && Array.isArray(profile.diary), "invalid_public_diary");
  requireCondition(profile.diary.length <= 31, "unexpected_public_window");
  const entries = new Map();
  for (const [path, content] of existing) {
    const match = ENTRY_PATH.exec(path);
    requireCondition(match && validDate(match[1]), "invalid_archive_path");
    const localDate = match[1];
    const header = /^# ([^\r\n]+)\n\n\*\*Claire's diary — (\d{4}-\d{2}-\d{2})\*\*\n\n/.exec(content);
    requireCondition(header && header[2] === localDate && !entries.has(localDate), "invalid_archive_entry");
    entries.set(localDate, { path, title: header[1], content });
  }
  const dates = new Set();
  const additions = [];
  for (const entry of profile.diary) {
    requireCondition(entry && validDate(entry.localDate) && entry.localDate <= now.toISOString().slice(0, 10), "invalid_public_date");
    requireCondition(!dates.has(entry.localDate), "duplicate_public_date");
    dates.add(entry.localDate);
    requireCondition(typeof entry.title === "string" && entry.title.length >= 1 && entry.title.length <= 200 &&
      !/[\r\n\u0000-\u001f\u007f<>]/u.test(entry.title), "invalid_public_title");
    requireCondition(typeof entry.content === "string" && entry.content.length >= 20 && entry.content.length <= 30_000 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry.content), "invalid_public_content");
    const content = renderEntry(entry);
    const previous = entries.get(entry.localDate);
    if (previous) {
      requireCondition(previous.content === content, "existing_entry_mismatch");
    } else {
      const path = `entries/${entry.localDate}.md`;
      additions.push({ path, content, date: entry.localDate });
      entries.set(entry.localDate, { path, title: entry.title, content });
    }
  }
  // The public endpoint is a rolling 31-entry window. Never silently skip a gap.
  const priorDates = [...existing.keys()].map((path) => ENTRY_PATH.exec(path)[1]).sort();
  if (profile.diary.length === 31) {
    requireCondition(priorDates.length > 0 && dates.has(priorDates.at(-1)), "public_window_gap_requires_review");
  }
  requireCondition(profile.diary.length > 0 || existing.size === 0, "unexpected_empty_public_diary");
  requireCondition(readme.split(START).length === 2 && readme.split(END).length === 2, "invalid_index_markers");
  const start = readme.indexOf(START) + START.length;
  const end = readme.indexOf(END);
  requireCondition(start < end, "invalid_index_markers");
  const index = [...entries.entries()].sort(([a], [b]) => b.localeCompare(a))
    .map(([date, entry]) => `- [${date} — ${markdownLabel(entry.title)}](${entry.path})`).join("\n");
  return {
    additions: additions.sort((a, b) => a.date.localeCompare(b.date)),
    readme: readme.slice(0, start) + `\n${index}\n` + readme.slice(end)
  };
}

export async function fetchPublicDiary(fetchImpl = fetch) {
  const response = await fetchImpl(PUBLIC_DIARY_URL, {
    headers: { accept: "application/json" }, redirect: "error",
    credentials: "omit", signal: AbortSignal.timeout(20_000)
  });
  requireCondition(response.ok, "public_diary_unavailable");
  requireCondition(response.headers.get("content-type")?.startsWith("application/json"), "unexpected_response_type");
  requireCondition(Number(response.headers.get("content-length") || 0) <= MAX_RESPONSE_BYTES, "response_too_large");
  requireCondition(response.body, "empty_response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireCondition(size <= MAX_RESPONSE_BYTES, "response_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SyncError("invalid_public_json");
  }
}

export async function loadArchive(root) {
  requireCondition((await lstat(resolve(root, "entries"))).isDirectory(), "invalid_entries_directory");
  requireCondition((await lstat(resolve(root, "README.md"))).isFile(), "invalid_readme_file");
  const existing = new Map();
  for (const file of await readdir(resolve(root, "entries"))) {
    const path = `entries/${file}`;
    requireCondition(ENTRY_PATH.test(path) && (await lstat(resolve(root, path))).isFile(), "invalid_archive_file");
    existing.set(path, await readFile(resolve(root, path), "utf8"));
  }
  return { existing, readme: await readFile(resolve(root, "README.md"), "utf8") };
}

export async function applyPlan(root, plan) {
  // Exclusive creation is a second guard against overwriting an existing file.
  for (const entry of plan.additions) {
    requireCondition(ENTRY_PATH.test(entry.path), "invalid_archive_path");
    await writeFile(resolve(root, entry.path), entry.content, { flag: "wx" });
  }
  await writeFile(resolve(root, "README.md"), plan.readme);
}

export function validateStagedChanges(changes, additions) {
  const expected = new Set(additions.map((entry) => entry.path));
  const seen = new Set();
  for (const line of changes.trim().split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    requireCondition((status === "A" && expected.has(path)) || (status === "M" && path === "README.md"), "unexpected_staged_change");
    seen.add(path);
  }
  requireCondition([...expected].every((path) => seen.has(path)), "missing_staged_entry");
}

export async function main(publish = false) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireCondition(!git("status", "--porcelain"), "dirty_worktree");
  if (publish) {
    requireCondition(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === "refs/heads/main", "wrong_publication_target");
    requireCondition(["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME), "untrusted_publication_event");
    requireCondition(git("remote", "get-url", "origin").replace(/\.git$/, "") === `https://github.com/${REPOSITORY}`, "unexpected_remote");
  }
  const archive = await loadArchive(root);
  const plan = planSync(await fetchPublicDiary(), archive.existing, archive.readme);
  console.log(JSON.stringify({ newEntries: plan.additions.length, dates: plan.additions.map((entry) => entry.date), mode: publish ? "publish" : "check" }));
  if (!publish || plan.additions.length === 0) return;
  await applyPlan(root, plan);
  git("add", "--", "README.md", ...plan.additions.map((entry) => entry.path));
  validateStagedChanges(git("diff", "--cached", "--name-status", "--no-renames"), plan.additions);
  git("-c", "user.name=Claire", "-c", "user.email=contact@clairegames.com", "commit", "-m",
    `diary: publish entries through ${plan.additions.at(-1).date}`);
  // Normal fast-forward only. A concurrent push fails safely; next run rechecks.
  git("push", "origin", "HEAD:refs/heads/main");
  console.log(JSON.stringify({ published: plan.additions.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--check", "--publish"].includes(args[0]))) {
    console.error("usage: node scripts/sync-diary.mjs [--check|--publish]");
    process.exitCode = 1;
  } else {
    main(args[0] === "--publish").catch((error) => {
      console.error(error instanceof SyncError ? error.message : "diary_sync_failed");
      process.exitCode = 1;
    });
  }
}
