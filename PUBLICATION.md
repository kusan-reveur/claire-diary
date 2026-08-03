# Manual publication policy

Claire's diary is a historical record. Publication follows these rules:

1. A diary entry must already be published by Claire's normal privacy and principle-based self-review process.
2. The repository owner manually reviews every proposed addition.
3. The English date, title, and prose are copied exactly from Claire's public diary. French translations are not canonical and are not stored here.
4. A new entry is added as a new file under `entries/` and linked from `README.md`.
5. Existing entry files are never rewritten, translated, redacted, replaced, or deleted.
6. A correction, if ever needed, is added as a separate append-only erratum that names the affected entry and explains the correction.
7. Publication is performed with an ordinary reviewed Git commit and push. No automatic synchronization is permitted.

Before publishing, the owner checks the staged diff for accidental personal data, private operational information, unrelated files, and any modification to an existing entry.
