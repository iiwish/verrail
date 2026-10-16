#!/bin/sh
set -eu
umask 077
: "${VERRAIL_GATEWAY_ROOT:?Gateway storage is required}"
case "$VERRAIL_GATEWAY_ROOT" in
  /*) ;;
  *) exit 1 ;;
esac
mkdir -p "$VERRAIL_GATEWAY_ROOT"
# Keep the lock in the persistent volume, across all gateway process lifetimes.
exec flock --exclusive --nonblock --no-fork "$VERRAIL_GATEWAY_ROOT/.lock" node /app/gateway.cjs
