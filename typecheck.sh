#!/usr/bin/env bash
# Type check every extension against the installed pi package.
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

config="$(mktemp -t pi-extensions-tsconfig).json"
trap 'rm -f "$config"' EXIT

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
    "baseUrl": "$root",
    "paths": {
      "@earendil-works/pi-ai": ["$pi/node_modules/@earendil-works/pi-ai"],
      "@earendil-works/pi-tui": ["$pi/node_modules/@earendil-works/pi-tui"],
      "@earendil-works/*": ["$global/@earendil-works/*"],
      "typebox": ["$pi/node_modules/typebox"]
    },
    "typeRoots": ["$global/@types", "$pi/node_modules/@types"]
  },
  "include": ["$root/lib/*.ts", "$root/*/[!.]*.ts"]
}
EOF

npx -y -p typescript@5.7 tsc -p "$config"
echo "typecheck: ok"
