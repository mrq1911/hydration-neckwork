#!/bin/sh
# Writes the sibling Explorer URL into the served bundle at container startup, so
# the same image can front any deployment. nginx's own entrypoint runs every *.sh
# in this directory before starting the server.
#
# Without this the URL would have to be inlined by Vite at build time, which means
# a rebuild and repush for every hostname change.
set -eu

CONFIG_FILE=/usr/share/nginx/html/config.js

# json_escape leaves a URL untouched in practice; it exists so a stray quote or
# backslash cannot break out of the string literal and corrupt the bundle.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ -n "${EXPLORER_URL:-}" ]; then
  escaped="$(json_escape "$EXPLORER_URL")"
  cat >"$CONFIG_FILE" <<EOF
window.__NECKWORK_CONFIG__ = { explorerUrl: "$escaped" };
EOF
  echo "40-runtime-config.sh: explorerUrl set to $EXPLORER_URL"
else
  cat >"$CONFIG_FILE" <<'EOF'
window.__NECKWORK_CONFIG__ = {};
EOF
  echo "40-runtime-config.sh: EXPLORER_URL unset; leaving the app on its build-time default"
fi
