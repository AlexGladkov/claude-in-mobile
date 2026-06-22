#!/usr/bin/env bash
#
# One-shot manual publish of the 4.0.0-dev scoped packages.
#
# PREREQUISITE: the npm org `@claude-in-mobile` must exist and you must be a
# member (CLI can't create it — make it on npmjs.com, Free/public). Verify:
#   npm org ls claude-in-mobile      # should list you, no 403
#
# The base `claude-in-mobile@4.0.0-dev` is already published under tag `dev`
# (latest stays 3.x). This script publishes the 6 scoped packages:
#   @claude-in-mobile/plugin-api      → latest (stable 1.0.0 contract)
#   @claude-in-mobile/plugin-{android,ios,web,desktop,aurora} → tag dev
#   @claude-in-mobile/plugin-all      → tag dev
#
# Source keeps `claude-in-mobile: "*"` (required so fresh `npm install` links
# the workspace root — see iteration-3 notes). This script rewrites that to the
# concrete `4.0.0-dev` ONLY for the published tarballs, then reverts.
set -euo pipefail
cd "$(dirname "$0")/.."

VER="4.0.0-dev"
PLUGINS=(plugin-android plugin-ios plugin-web plugin-desktop plugin-aurora)

echo "==> npm user: $(npm whoami)"
echo "==> verifying @claude-in-mobile org access…"
npm org ls claude-in-mobile >/dev/null || {
  echo "ERROR: no access to @claude-in-mobile org. Create it on npmjs.com first." >&2
  exit 1
}

revert() {
  echo "==> reverting plugin deps back to '*'"
  node -e '
    const fs=require("fs");
    for(const pk of process.argv.slice(1)){
      const p="packages/"+pk+"/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));
      if(j.dependencies&&j.dependencies["claude-in-mobile"]) j.dependencies["claude-in-mobile"]="*";
      fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
    }
    const ap="packages/plugin-all/package.json";const aj=JSON.parse(fs.readFileSync(ap,"utf8"));
    for(const k of Object.keys(aj.dependencies||{})) aj.dependencies[k]="*";
    fs.writeFileSync(ap,JSON.stringify(aj,null,2)+"\n");
  ' "${PLUGINS[@]}"
}
trap revert EXIT

echo "==> pinning published deps to ${VER}"
node -e '
  const fs=require("fs");const ver=process.argv[1];
  for(const pk of process.argv.slice(2)){
    const p="packages/"+pk+"/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));
    if(j.dependencies&&j.dependencies["claude-in-mobile"]) j.dependencies["claude-in-mobile"]=ver;
    fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
  }
  const ap="packages/plugin-all/package.json";const aj=JSON.parse(fs.readFileSync(ap,"utf8"));
  for(const k of Object.keys(aj.dependencies||{})) aj.dependencies[k]=ver;
  fs.writeFileSync(ap,JSON.stringify(aj,null,2)+"\n");
' "$VER" "${PLUGINS[@]}"

echo "==> clean build"
rm -rf dist packages/*/dist
npm run build

echo "==> publish plugin-api (latest)"
npm publish -w @claude-in-mobile/plugin-api --access public

for pk in "${PLUGINS[@]}"; do
  echo "==> publish $pk (tag dev)"
  npm publish -w "@claude-in-mobile/$pk" --access public --tag dev
done

echo "==> publish plugin-all (tag dev)"
npm publish -w @claude-in-mobile/plugin-all --access public --tag dev

echo "==> done. verify:"
echo "    npm view @claude-in-mobile/plugin-ios dist-tags"
echo "    (cd /tmp && rm -rf s && mkdir s && cd s && npm init -y >/dev/null && \\"
echo "       npm i claude-in-mobile@dev @claude-in-mobile/plugin-ios@dev)"
