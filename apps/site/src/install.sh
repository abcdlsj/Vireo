#!/bin/sh
# Sets up a Vireo node on this machine, as a background service:
#
#   curl -fsSL https://askvireo.com/install.sh | sh
#
# Uses the Node.js already here when it is new enough (22.13 or later), else
# puts its own copy in ~/.config/vireo/runtime, touching nothing else. Then it
# runs `askvireo service install`, which links the node to your account,
# starts it at login, and connects Claude Code and Codex if they are here.
# Running it again upgrades the node.
set -eu

PACKAGE="askvireo"
NODE_MAJOR=22
NODE_MIN="22.13.0"
DATA="${VIREO_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/vireo}"
RUNTIME="$DATA/runtime"

say() { printf '%s\n' "$*"; }
fail() {
  say "Vireo: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this installer is for macOS and Linux. Elsewhere, run: npx $PACKAGE" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no Node.js build for $(uname -m); install Node.js $NODE_MIN or later yourself, then run: npx $PACKAGE service install" ;;
esac

# True when version $1 is at least $2 (both x.y.z).
at_least() {
  printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n -C
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    fail "needs curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

node_bin=""
# Our own copy first, so an upgrade keeps using it; then the one on PATH.
for candidate in "$RUNTIME/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  version="$("$candidate" -v 2>/dev/null | sed 's/^v//')" || continue
  if at_least "$version" "$NODE_MIN"; then
    node_bin="$candidate"
    break
  fi
done

if [ -z "$node_bin" ]; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  say "Getting Node.js $NODE_MAJOR for Vireo (into $RUNTIME, nothing else changes) …"
  sums="$(fetch "$base/SHASUMS256.txt")" || fail "could not reach nodejs.org"
  file="$(printf '%s\n' "$sums" | awk -v want="-$os-$arch.tar.gz" '{ if (index($2, want) && $2 !~ /\//) { print $2; exit } }')"
  [ -n "$file" ] || fail "no Node.js $NODE_MAJOR build for $os $arch"
  expected="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fetch "$base/$file" >"$tmp/node.tar.gz" || fail "could not download $file"
  [ "$(sha256 "$tmp/node.tar.gz")" = "$expected" ] || fail "the download of $file does not match its checksum"
  mkdir -p "$tmp/x"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp/x"
  mkdir -p "$RUNTIME"
  rm -rf "$RUNTIME/node"
  mv "$tmp/x/${file%.tar.gz}" "$RUNTIME/node"
  node_bin="$RUNTIME/node/bin/node"
fi

bin_dir="$(dirname "$node_bin")"
PATH="$bin_dir:$PATH"
export PATH
say "Using Node.js $("$node_bin" -v) at $node_bin"

# The service asks a question or two; read the answers from the terminal even
# though this script itself arrives through a pipe.
if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then
  exec "$bin_dir/npx" --yes "$PACKAGE@latest" service install "$@" </dev/tty
fi
exec "$bin_dir/npx" --yes "$PACKAGE@latest" service install "$@"
