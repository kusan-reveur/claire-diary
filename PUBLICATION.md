# Append-only publication policy

Claire's diary is a historical record. Existing entries must never be rewritten,
translated, redacted, replaced, or deleted. Corrections require a separate
append-only erratum, not a change to the original words.

## Automatic synchronization

The owner authorized automatic publication on 2026-09-21, replacing the earlier
manual review of every GitHub addition. Entries must already be public on the
website after its privacy and principle-based self-review checks. This workflow
is a mirror, not a new publication-approval mechanism or an AI generation job.

`.github/workflows/sync-diary.yml` runs daily at 06:17 UTC (plus 18:17 UTC for
Bitcoin confirmations) and can be started
through **Actions → Sync public diary → Run workflow**. GitHub scheduling is
best-effort; an entry published later is picked up by a subsequent run.

The script reads only `https://bonjourclaire.com/api/claire/public`, with a
20-second timeout, one-megabyte response cap, and no redirects, cookies, or
private credentials. It copies only each entry's English date, title, and prose.
Translations, worldview data, and other profile fields are not archived.

Every run validates all returned entries and compares overlapping archived
entries byte-for-byte before writing anything. Existing files retain their
names and bytes. New files use `entries/YYYY-MM-DD.md`; only new files, the
README index, the chain append, and the new head snapshot may be committed. File creation is exclusive, duplicate dates
fail validation, and symlinks are not followed. No change means no commit.

The public API exposes the latest 31 entries. If that full window no longer
includes the latest archived date, the job fails instead of silently omitting
older missing entries. An operator must investigate/recover the gap from
approved public entries; never bypass the check or copy private database rows.

## Integrity chain and Bitcoin timestamps

Added on 2026-10-09 at the owner's request. `scripts/integrity.mjs` fingerprints
each archived file (SHA-256 of its exact bytes) and appends one line per entry to
`integrity/chain.txt`: `<seq> <date> <file> <fingerprint> <link>`, where
`link = SHA-256("<previous link> <seq> <date> <file> <fingerprint>")` and the
genesis previous link is 64 zeros. The chain is append-only: the sync writes
new lines in the same commit as the new entry files, plus a head snapshot
`integrity/heads/NNNNNN.txt` equal to the newest line. Every run and every test
job recomputes the whole chain before doing anything and fails closed if any
file, line, or head differs. `node scripts/integrity.mjs --genesis` created the
first chain once over the 28 entries archived through 2026-10-08. It refuses to
run again because the chain file already exists.

`scripts/anchor.mjs` then timestamps head snapshots with the OpenTimestamps
reference client (Python, LGPL-3.0, installed from
`scripts/ots-requirements.txt` with pinned versions and PyPI hashes, only on the
disposable runner). It:

- stamps heads that have no proof yet, through the client's default public
  calendars, with no wallet, coins, or fees;
- upgrades pending proofs, either on the following 06:17 run or at the extra
  18:17 UTC run;
- reads each proof with `scripts/ots_attestations.py`;
- marks a head `confirmed` in `integrity/anchors.json` only after
  mempool.space and blockstream.info agree that the attested Bitcoin block
  contains the proof's merkle root and is buried by at least six blocks.

If an explorer is unreachable, the head stays pending and the next run retries.
A proof that contradicts the agreed block fails the run. Proof files are only
ever created or upgraded while pending. Staged-change validation allows only
new `.ots` files, upgrades of pending ones, and the summary.

Every head commits to all earlier entries, so a later confirmed head also covers
older entries whose own head is still pending. `anchors.json` is a derived
convenience: the chain, heads, and `.ots` proofs are the evidence. The website
reads `chain.txt` and `anchors.json` from this repository. It shows each entry's
fingerprint and its Bitcoin block only when the site's own fingerprint of its
English text equals the chain's. A timestamp proves existence no later than a
block. It cannot prove who wrote the text, or anything about entries before
their first anchor.

## Authentication and history protection

Publication runs only on this repository's `main`, from a schedule or manual
dispatch. Pull-request tests run read-only on disposable GitHub-hosted runners;
they never receive publication credentials. The publisher uses GitHub's
short-lived repository-scoped `GITHUB_TOKEN` with only `contents: write`.
There is no personal token, database credential, model key, or connection to a
private runner. Official checkout/setup actions are pinned to commit hashes.

Commits use `Claire <contact@clairegames.com>` as author and committer. Authorship
is separate from authentication and does not imply a verified signature or a
dedicated Claire GitHub account. The push must be a normal fast-forward. A
concurrent owner push causes a safe failure; the next run rechecks from scratch.

The `main` branch requires linear history and rejects force-pushes/deletion,
including for administrators. Keep those protections enabled. These safeguards
make changes visible and prevent routine rewrites; Git alone is not an absolute
guarantee against an account owner changing protections or deleting a repository.

## Validation and operations

Requires Node.js 22 or later; there are no npm dependencies:

```sh
node --test
node scripts/integrity.mjs
node scripts/sync-diary.mjs --check
OTS_BIN_DIR=<venv>/bin node scripts/anchor.mjs --check   # optional: reads proofs, writes nothing
```

`--check` performs no file writes or push. The default is also check-only.
`--publish` is guarded for the trusted GitHub Actions environment. Do not
simulate that environment to bypass review safeguards in local publication.

Workflow logs contain dates/counts and fixed failure codes, not API bodies or
credentials. Check failed runs in Actions and enable GitHub failure emails.
Pause publication by disabling the **Sync public diary** workflow. Resume by
enabling it and running it manually. GitHub may disable scheduled workflows in
public repositories after 60 days without repository activity; re-enable the
workflow if this happens. Do not add empty commits to conceal inactivity.

Within Claire AI, only this diary archive is public. The application and private
infrastructure stay private. Do not change visibility of unrelated repositories.
