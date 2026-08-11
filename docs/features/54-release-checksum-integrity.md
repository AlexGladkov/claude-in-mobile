# Feature #54 — Release checksum integrity (sidecar validation)

Date: 2026-08-11 · Type: fix (release pipeline / supply-chain hygiene)
Issue: https://github.com/AlexGladkov/claude-in-mobile/issues/54

## Problem

The `.sha256` sidecar files published next to release tarballs do not match the
actual tarballs (observed on v3.14.0). `brew install` still works because
Homebrew uses the formula-embedded `sha256`, not the sidecar — so this is not
install-breaking, but a published checksum that lies about its artifact erodes
trust and conditions users/maintainers to ignore checksum mismatches.

## Root cause (consilium — confirmed via asset uploader field)

v3.14.0 was released **manually** (CI runners were unavailable). A human
uploaded the `.sha256` files from a local machine; those local tarballs were
produced by a different `tar -czf` invocation than CI's (gzip metadata — mtime,
OS — makes `tar` non-deterministic across machines), so the local hashes
differed. CI later ran and its `release` job re-uploaded **only** `*.tar.gz`
(the `files: "*.tar.gz"` glob does not match `*.tar.gz.sha256`), leaving the
stale, wrong sidecars in place. Nothing downstream re-validates the sidecar, so
it shipped.

## Decision (DoR)

- **Keep** the per-file `.sha256` sidecars (manual-download UX) rather than drop
  them — dropping forces re-plumbing platform discovery in `update-homebrew`
  (which parses `.sha256` filenames), touching the load-bearing brew path. Higher
  risk for no user benefit.
- Make **CI own** the sidecars (upload them in the `release` job) so a stale
  manual sidecar can never survive a CI run.
- Add a **hard** self-consistency check to `verify-checksums`.
- Also make the formula check **platform-bound** (was presence-anywhere `grep`),
  closing a latent silent-mis-bind risk (correct hash bound to the wrong arch
  would still pass the old check).
- Extract the verification into `scripts/verify-release-checksums.sh` (network-free,
  unit-testable); the workflow only does `gh` downloads then calls it.

## Definition of Done (DoD)

### Behaviour / outcomes (the "states" of a CI verification)

| State | Input | Required outcome |
|-------|-------|------------------|
| **All-match** | every tarball's sha == its sidecar == the formula sha for that platform | exit 0, "verified" per asset |
| **Sidecar-wrong** | a sidecar's hash ≠ its tarball | `::error::` naming the asset, exit 1 |
| **Sidecar-missing** | `<tarball>.sha256` absent | `::error::` naming the asset, exit 1 |
| **Formula-mismatch** | tarball sha not present for that platform's block in the formula | `::error::`, exit 1 |
| **Formula-misbind** | correct hash but bound to the wrong platform's block | `::error::` (platform-bound check catches it), exit 1 |
| **No tarballs** | assets dir has no `*.tar.gz` | `::error::`, exit 1 |
| **Multi-platform** | N tarballs | each checked independently; one failure fails the job |

### Edge cases

- E1 sidecar format `<hash>  <file>` (two spaces) → parse first field only.
- E2 fractional/garbage in sidecar → compared as-is, mismatch → fail.
- E3 `sha256sum` vs `shasum` — script must work on ubuntu-latest (both exist; use one consistently).
- E4 formula uses `#{version}` interpolation in the URL — platform token (`darwin-arm64`) is still literally present in the url line; bind on that.
- E5 all failures aggregated (do not exit on first) so one run reports every broken asset.
- E6 script is pure/local: no network, no `gh` — inputs are a formula file + a directory of already-downloaded assets + version.

### Pipeline changes

- `release` job uploads `*.tar.gz` **and** `*.tar.gz.sha256`.
- `verify-checksums` downloads tarballs **and** sidecars **and** the formula, then delegates to the script.

### Validation

- Unit test (`scripts/verify-release-checksums.test.ts`) drives the script over
  fixtures covering every state above (all-match, sidecar-wrong, sidecar-missing,
  formula-mismatch, formula-misbind, no-tarballs).
- `actionlint` / YAML sanity on `release.yml` (or manual review — no runner here).
- Existing suite stays green.

### Remediation (separate, outward action — confirm before executing)

- Regenerate correct `.sha256` for the existing v3.14.0 release via
  `gh release upload --clobber` (tarballs untouched; hashes already public via
  the formula). Requires explicit go — mutates a published release.

## Out of scope (recorded, not done here)

- `actions/attest-build-provenance` for tarballs (cross-origin authenticity) —
  proportionate future enhancement, not required to fix #54.
- Rewriting the `update-homebrew` python sha-substitution to be platform-bound —
  the new verify-side platform-bound guard already *catches* a mis-bind and fails
  the release; preventing it in the substitution is a lower-risk follow-up.
