#!/usr/bin/env bash
# Type check every extension against the installed pi package.
#
# The include glob is recursive on purpose: it used to be one level deep
# (*/[!.]*.ts), which silently skipped any file an extension put in a
# subdirectory.
#
# There is no build step (pi loads TypeScript through jiti), so this is the only
# thing that catches type errors. The tsconfig is generated rather than
# committed because it has to point at the *globally* installed pi, whose path
# differs per machine and per node version manager.
set -euo pipefail

cd "$(dirname "$0")"
root="$PWD"
global="$(npm root -g)"
pi="$global/@earendil-works/pi-coding-agent"

if [[ ! -d "$pi" ]]; then
	echo "pi is not installed globally (looked in $global)" >&2
	exit 1
fi

# `mktemp -d` rather than `mktemp -t <prefix>`: BSD/macOS appends the random part
# to a bare prefix, GNU coreutils requires an explicit XXXXXX and errors without
# one, so the -t form worked locally and failed in CI. A directory also lets the
# config keep a real .json name — appending the extension to a mktemp'd path
# meant writing to a file mktemp had not created, leaking the one it had.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
config="$workdir/tsconfig.json"

cat >"$config" <<EOF
{
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
    "target": "es2022",
    "lib": ["es2022"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "baseUrl": "$root",
    "paths": {
      "@earendil-works/pi-ai": ["$pi/node_modules/@earendil-works/pi-ai"],
      "@earendil-works/pi-tui": ["$pi/node_modules/@earendil-works/pi-tui"],
      "@earendil-works/*": ["$global/@earendil-works/*"],
      "typebox": ["$pi/node_modules/typebox"]
    },
    "typeRoots": ["$global/@types", "$pi/node_modules/@types"]
  },
  "include": ["$root/**/*.ts"],
  "exclude": ["$root/**/node_modules/**"]
}
EOF

npx -y -p typescript@5.7 tsc -p "$config"
echo "typecheck: ok"
