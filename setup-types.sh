#!/usr/bin/env bash
# Recreate node_modules/ (symlinks to the globally installed pi package).
#
# The committed tsconfig.json resolves extensions through node_modules, but the
# repo has no dependencies of its own — the pi types come from the *globally
# installed* @earendil-works/pi-coding-agent. node_modules/ is gitignored
# (absolute symlink targets differ per machine and per node version manager),
# so recreate it after a fresh clone or a pi reinstall with this script.
#
# Everything except pi-coding-agent resolves from INSIDE its node_modules: the
# package bundles pi-ai, pi-tui, and typebox as nested deps and does not publish
# them at the top level of the npm global root.
set -euo pipefail

cd "$(dirname "$0")"
root="$PWD"
pi="$(npm root -g)/@earendil-works/pi-coding-agent"

if [[ ! -d "$pi" ]]; then
	echo "pi is not installed globally (looked in $pi)" >&2
	exit 1
fi

scoped="$root/node_modules/@earendil-works"
types="$root/node_modules/@types"
mkdir -p "$scoped" "$types"

ln -sfn "$pi" "$scoped/pi-coding-agent"
ln -sfn "$pi/node_modules/@earendil-works/pi-ai" "$scoped/pi-ai"
ln -sfn "$pi/node_modules/@earendil-works/pi-tui" "$scoped/pi-tui"
ln -sfn "$pi/node_modules/typebox" "$root/node_modules/typebox"
ln -sfn "$pi/node_modules/@types/node" "$types/node"

echo "setup-types: linked pi types into node_modules/"
