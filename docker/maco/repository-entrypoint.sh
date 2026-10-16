#!/bin/sh
set -eu
umask 077
: "${VERRAIL_REPOSITORY_ROOT:?Repository runtime storage is required}"
case "$VERRAIL_REPOSITORY_ROOT" in
  /*) ;;
  *) exit 1 ;;
esac
test -d "$VERRAIL_REPOSITORY_ROOT"
test ! -L "$VERRAIL_REPOSITORY_ROOT"
# The release must mount the same private root into every repository executor.
# Holding the lock across the process tree bounds this service to one DB pool.
exec flock --exclusive --nonblock --no-fork "$VERRAIL_REPOSITORY_ROOT/.lock" \
  python3 /usr/local/lib/verrail/runtime_env.py \
  node --import /app/server/node_modules/tsx/dist/loader.mjs \
  /app/server/dist/execution/repository-execution-main.js
