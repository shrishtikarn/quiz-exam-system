#!/bin/bash
# Builds a self-contained release: application, production packages, Node.js and the RDS CA bundle.
# Usage: scripts/build-release.sh [version]
source "$(dirname "$0")/lib.sh"

NODE_DIST="https://nodejs.org/dist/latest-v22.x"
RDS_CA_URL="https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"

cd "${REPO_ROOT}"
version="${1:-$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
[[ "${version}" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid version: ${version}"

work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT
app="${work}/app"
mkdir -p "${app}/runtime" "${app}/certs" dist

log "Downloading the latest Node.js 22 release and checking its checksum"
curl -fsSL "${NODE_DIST}/SHASUMS256.txt" -o "${work}/SHASUMS256.txt"
node_file=$(awk '/linux-x64\.tar\.gz$/ {print $2}' "${work}/SHASUMS256.txt")
[ -n "${node_file}" ] || die "Could not find the Node.js download"
curl -fsSL "${NODE_DIST}/${node_file}" -o "${work}/${node_file}"
(cd "${work}" && grep " ${node_file}\$" SHASUMS256.txt | sha256sum -c --quiet -)
tar -xzf "${work}/${node_file}" -C "${app}/runtime" --strip-components=1

log "Copying the application"
cp -R src public db dataset package.json "${app}/"
[ -f package-lock.json ] && cp package-lock.json "${app}/"
curl -fsSL "${RDS_CA_URL}" -o "${app}/certs/rds-global-bundle.pem"

log "Installing production packages"
(
  cd "${app}"
  export PATH="${app}/runtime/bin:${PATH}"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund
  fi
)

# The server only needs the node binary at run time.
rm -rf "${app}/runtime/lib/node_modules" "${app}/runtime/include" "${app}/runtime/share" \
  "${app}/runtime/bin/npm" "${app}/runtime/bin/npx" "${app}/runtime/bin/corepack"
printf '%s\n' "${version}" >"${app}/VERSION"

tar -czf "dist/${version}.tar.gz" -C "${app}" .
log "Built dist/${version}.tar.gz ($(du -h "dist/${version}.tar.gz" | cut -f1))"
printf '%s\n' "${version}" >dist/LATEST
