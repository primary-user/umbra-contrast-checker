#!/usr/bin/env bash
#
# Fetch Adobe's signing tool, ZXPSignCmd, into tools/bin/.
#
#   tools/get-zxpsigncmd.sh
#
# Adobe publishes ZXPSignCmd for macOS and Windows only. This takes the June
# 2025 build, which carries Adobe's fix for timestamped signing, from a pinned
# release of vite-cep-plugin. That package ships Adobe's binaries as plain
# files, where Adobe's own download wraps the Mac build in a disk image.
#
# The file is checked against a SHA-256 recorded here before it is used. A
# mismatch stops the script, so a changed upstream file can never sign a
# release.
#
# On Apple silicon the Mac build runs through Rosetta, because Adobe ships it
# for Intel only. The script says so if Rosetta is missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/tools/bin"

PACKAGE="vite-cep-plugin"
PACKAGE_VERSION="2.2.3"

die() { printf '\n%s\n\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
    Darwin)
        FILE="ZXPSignCmd"
        SUM="bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        FILE="ZXPSignCmd.exe"
        SUM="ffc2223167225ce61d024eb463fc5ad1a1be16133f99ef334a646f7311916c98"
        ;;
    *)
        die "Adobe publishes ZXPSignCmd for macOS and Windows only. Build the .zxp on one of those, or let the release workflow on GitHub do it."
        ;;
esac

command -v npm >/dev/null 2>&1 || die "npm is needed to fetch the signing tool. Install Node.js from nodejs.org and run this again."

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

if [[ -f "$BIN/$FILE" && "$(sha256 "$BIN/$FILE")" == "$SUM" ]]; then
    printf 'ZXPSignCmd is already in tools/bin.\n'
else
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT

    # npm pack downloads the package as a tarball and stops there. Nothing is
    # installed and none of the package's scripts run.
    ( cd "$WORK" && npm pack "$PACKAGE@$PACKAGE_VERSION" --silent >/dev/null )

    ( cd "$WORK" && tar -xzf "$PACKAGE-$PACKAGE_VERSION.tgz" "package/lib/bin/$FILE" )

    GOT="$(sha256 "$WORK/package/lib/bin/$FILE")"
    [[ "$GOT" == "$SUM" ]] || die "ZXPSignCmd did not match the recorded checksum, so it was not used.

expected $SUM
received $GOT"

    mkdir -p "$BIN"
    cp "$WORK/package/lib/bin/$FILE" "$BIN/$FILE"
    chmod 755 "$BIN/$FILE"
    printf 'Fetched ZXPSignCmd into tools/bin.\n'
fi

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] &&
   ! arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
    printf '\nThis Mac needs Rosetta to run ZXPSignCmd. Install it with:\n'
    printf '  softwareupdate --install-rosetta --agree-to-license\n\n'
fi
