#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --test test/*.test.cjs
node scripts/build.cjs
node --check dist/hust-course-picker.user.js
