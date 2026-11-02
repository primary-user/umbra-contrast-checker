#!/usr/bin/env bash
#
# Build and sign the distributable .zxp.
#
#   tools/get-zxpsigncmd.sh      fetch Adobe's signing tool into tools/bin, once
#   tools/package.sh             build dist/UmbraContrastChecker-<version>.zxp
#
# Releases are built on GitHub by .github/workflows/release.yml, which runs this
# script on a Mac and on a Windows machine. It runs the same way on your own
# computer when you want a build to try before releasing.
#
# Signing tool. tools/bin/ZXPSignCmd if tools/get-zxpsigncmd.sh put it there,
# otherwise ZXPSignCmd on your PATH, or set ZXPSIGNCMD to its full path.
#
# Certificate. With none, the build makes a throwaway self-signed certificate and
# deletes it afterwards. That is everything a .zxp needs to install without
# debug mode. To sign with a certificate of your own, set UMBRA_CERT to the .p12
# and UMBRA_CERT_PASSWORD to its password, or run tools/package.sh --cert once to
# make a lasting self-signed one at tools/cert.p12.
#
# UMBRA_ZXP sets where the .zxp is written.
#
# Sign on the platform your users run on. Adobe's guidance is to build the
# Windows .zxp on Windows, which is why the release workflow builds two.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="Umbra Contrast Checker"
SLUG="UmbraContrastChecker"
STAGE="$ROOT/build/$NAME"
DIST="$ROOT/dist"

# Everything a user needs and nothing else. The test suite, the docs, the CI
# config and the debug port are all development furniture.
INCLUDE=(CSXS client host LICENSE)

# Tried in order. ZXPSignCmd refuses a timestamp it cannot verify, so a server
# that is down or untrusted on this platform simply falls through to the next.
TSAS=(http://timestamp.digicert.com http://timestamp.sectigo.com http://timestamp.apple.com/ts01)
[[ -n "${UMBRA_TSA:-}" ]] && TSAS=("$UMBRA_TSA")

die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

# Paths handed to a Windows program need Windows spelling. Git Bash converts most
# of them by itself, and cygpath makes it certain.
native() {
    if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# A throwaway password. Hex, so it survives every quoting rule on both platforms.
throwaway_password() { od -An -tx1 -N16 /dev/urandom | tr -d ' \n'; }

ask_password() {
    [[ -t 0 ]] || die "A certificate password is needed and there is no terminal to ask for it. Set UMBRA_CERT_PASSWORD."
    local answer
    read -r -s -p "$1 " answer; echo >&2
    printf '%s' "$answer"
}

find_signer() {
    if [[ -n "${ZXPSIGNCMD:-}" ]]; then printf '%s' "$ZXPSIGNCMD"; return; fi
    local candidate
    for candidate in "$ROOT/tools/bin/ZXPSignCmd" "$ROOT/tools/bin/ZXPSignCmd.exe"; do
        [[ -f "$candidate" ]] && { printf '%s' "$candidate"; return; }
    done
    command -v ZXPSignCmd 2>/dev/null || command -v ZXPSignCmd.exe 2>/dev/null || true
}

SIGN="$(find_signer)"
if [[ -z "$SIGN" ]] || ! command -v "$SIGN" >/dev/null 2>&1; then
    die "ZXPSignCmd not found.

Fetch it with:
  tools/get-zxpsigncmd.sh
or put Adobe's ZXPSignCmd on your PATH, or run:
  ZXPSIGNCMD=/full/path/to/ZXPSignCmd tools/package.sh"
fi

make_cert() {   # make_cert <path> <password>
    "$SIGN" -selfSignedCert US CT "Artchemy Labs LLC" "Artchemy Labs LLC" \
            "$2" "$(native "$1")" >/dev/null
    [[ -s "$1" ]] || die "ZXPSignCmd did not write a certificate to $1."
}

# ---------------------------------------------------------------------------
# Optional: a lasting self-signed certificate.
#
# Not needed for a release. Every certificate this script makes, throwaway or
# lasting, names Artchemy Labs LLC, so installers show the same publisher either
# way. Keep one only if you want every build signed by the same key.
if [[ "${1:-}" == "--cert" ]]; then
    CERT="${UMBRA_CERT:-$ROOT/tools/cert.p12}"
    [[ -f "$CERT" ]] && die "$CERT already exists. Delete it first if you mean to replace it."

    PASS="${UMBRA_CERT_PASSWORD:-}"
    [[ -n "$PASS" ]] || PASS="$(ask_password "Choose a password for the certificate:")"
    [[ -n "$PASS" ]] || die "A password is required."

    mkdir -p "$(dirname "$CERT")"
    make_cert "$CERT" "$PASS"

    printf '\nWrote %s\n' "$CERT"
    printf 'A .p12 is a private key. Keep it out of the repository and keep the password.\n\n'
    exit 0
fi

VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' CSXS/manifest.xml)"
[[ -n "$VERSION" ]] || die "Could not read the version out of CSXS/manifest.xml."

OUT="${UMBRA_ZXP:-$DIST/$SLUG-$VERSION.zxp}"
[[ "$OUT" == /* || "$OUT" == [A-Za-z]:* ]] || OUT="$ROOT/$OUT"

# ---------------------------------------------------------------------------
# Stage a clean copy.
rm -rf "$ROOT/build"
trap 'rm -rf "$ROOT/build"' EXIT
mkdir -p "$STAGE" "$(dirname "$OUT")"

for item in "${INCLUDE[@]}"; do
    [[ -e "$item" ]] || die "Missing $item. Run this from a complete checkout."
    cp -R "$item" "$STAGE/"
done

# macOS scatters these through any folder Finder has looked at, and a stray one
# breaks signature verification on some installers.
find "$STAGE" \( -name '.DS_Store' -o -name '__MACOSX' -o -name 'Thumbs.db' \) \
     -exec rm -rf {} + 2>/dev/null || true

# Symlinks survive signing and then arrive on the user's machine as plain text
# files, which produces a blank panel that verifies as corrupt. Refuse rather
# than ship one.
if find "$STAGE" -type l | grep -q .; then
    find "$STAGE" -type l >&2
    die "The staged build contains symlinks, which do not survive .zxp installation."
fi

# The debug port must never reach a build. It is gitignored, but a local copy
# sitting in the working tree is exactly how it would get in.
[[ -e "$STAGE/.debug" ]] && die "A .debug file reached the staging folder. Remove it."

# ---------------------------------------------------------------------------
# Choose the certificate.
if [[ -n "${UMBRA_CERT:-}" || -f "$ROOT/tools/cert.p12" ]]; then
    CERT="${UMBRA_CERT:-$ROOT/tools/cert.p12}"
    [[ -f "$CERT" ]] || die "No certificate at $CERT."
    PASS="${UMBRA_CERT_PASSWORD:-}"
    [[ -n "$PASS" ]] || PASS="$(ask_password "Certificate password:")"
    [[ -n "$PASS" ]] || die "A certificate password is required."
    printf 'Signing with %s\n' "$CERT"
else
    CERT="$ROOT/build/throwaway.p12"
    PASS="$(throwaway_password)"
    make_cert "$CERT" "$PASS"
    printf 'Signing with a throwaway self-signed certificate.\n'
fi

# ---------------------------------------------------------------------------
# Sign.
#
# The timestamp is not optional in practice. Without it the .zxp stops
# installing the moment the certificate expires, and every user hits a wall at
# once. So every server is tried before giving up, and giving up means no .zxp.
SIGNED=""
for tsa in "${TSAS[@]}"; do
    rm -f "$OUT"
    if "$SIGN" -sign "$(native "$STAGE")" "$(native "$OUT")" "$(native "$CERT")" "$PASS" \
               -tsa "$tsa" && [[ -s "$OUT" ]]; then
        SIGNED="$tsa"
        break
    fi
    printf 'Timestamp server %s did not work here.\n' "$tsa" >&2
done
[[ -n "$SIGNED" ]] || { rm -f "$OUT"; die "No timestamp server worked, so no .zxp was written."; }

# Read the result back the way an installer will.
CHECK="$("$SIGN" -verify "$(native "$OUT")" 2>&1 || true)"
printf '%s\n' "$CHECK"
grep -Eq 'verified successfully|verified OK' <<<"$CHECK" || {
    rm -f "$OUT"
    die "The .zxp did not verify, so it was deleted."
}

printf '\nBuilt %s\n' "$OUT"
printf 'Version %s, timestamped by %s.\n\n' "$VERSION" "$SIGNED"
