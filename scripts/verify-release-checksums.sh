#!/usr/bin/env bash
#
# verify-release-checksums.sh — assert release artifact integrity (issue #54).
#
# Pure / local: no network, no `gh`. The release workflow downloads the assets
# and the formula first, then calls this so the logic is unit-testable.
#
# For every `<prefix>-<platform>.tar.gz` in ASSETS_DIR it asserts, aggregating
# ALL failures before exiting:
#   1. the tarball's sha256 == its `<tarball>.sha256` sidecar   (self-consistency)
#   2. the tarball's sha256 == the formula's sha256 bound to THAT platform's
#      url block                                                (platform-bound)
#
# Usage: verify-release-checksums.sh <formula.rb> <assets_dir> <version>
#
set -euo pipefail

FORMULA="${1:?formula path required}"
ASSETS_DIR="${2:?assets dir required}"
VERSION="${3:?version required}"
PREFIX="claude-in-mobile-${VERSION}-"

err() { echo "::error::$*" >&2; }

# sha256 of a file → bare hex. Works on Linux (sha256sum) and macOS (shasum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# The formula sha256 bound to a platform's url block: scan for the line whose
# url contains "<platform>.tar.gz", then take the first following sha256 "...".
# `#{version}` interpolation in the formula url keeps the platform token literal.
formula_sha_for_platform() {
  local platform="$1"
  awk -v needle="${platform}.tar.gz" '
    index($0, needle) { armed = 1 }
    armed && match($0, /[a-f0-9]{64}/) { print substr($0, RSTART, RLENGTH); exit }
  ' "$FORMULA"
}

if [ ! -f "$FORMULA" ]; then
  err "Formula not found: $FORMULA"
  exit 1
fi

shopt -s nullglob
tarballs=("$ASSETS_DIR"/${PREFIX}*.tar.gz)
if [ ${#tarballs[@]} -eq 0 ]; then
  err "No ${PREFIX}*.tar.gz assets found in ${ASSETS_DIR}"
  exit 1
fi

failed=0
for tarball in "${tarballs[@]}"; do
  base="$(basename "$tarball")"
  platform="${base#"$PREFIX"}"
  platform="${platform%.tar.gz}"
  echo "== ${base} (platform: ${platform}) =="

  actual="$(sha256_of "$tarball")"
  echo "   tarball sha256: ${actual}"

  # 1) sidecar self-consistency
  sidecar="${tarball}.sha256"
  if [ ! -f "$sidecar" ]; then
    err "Sidecar missing: ${base}.sha256"
    failed=1
  else
    sidecar_hash="$(awk '{print $1}' "$sidecar")"
    if [ "$sidecar_hash" != "$actual" ]; then
      err "Sidecar mismatch for ${base}: sidecar=${sidecar_hash} actual=${actual}"
      failed=1
    else
      echo "   sidecar OK"
    fi
  fi

  # 2) platform-bound formula check
  expected="$(formula_sha_for_platform "$platform")"
  if [ -z "$expected" ]; then
    err "Formula has no sha256 bound to platform ${platform}"
    failed=1
  elif [ "$expected" != "$actual" ]; then
    err "Formula mismatch for ${platform}: formula=${expected} actual=${actual}"
    failed=1
  else
    echo "   formula OK"
  fi
done

if [ "$failed" -ne 0 ]; then
  err "Release checksum verification FAILED — see errors above."
  exit 1
fi

echo "All release checksums verified (tarball == sidecar == formula, per platform)."
