#!/bin/sh
# Read-only inspection: all outgoing endpoints and write guards are in these files.
set -eu
cd "$(dirname "$0")/.."
printf '\n--- Endpoint adapter ---\n'
cat src/api.js
printf '\n--- Write and confirmation state machine ---\n'
cat src/engine.js
