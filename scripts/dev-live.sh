#!/usr/bin/env bash
set -euo pipefail

service_name="${MATTER_LAYER_SYSTEM_SERVICE:-matter-layer.service}"
rules_module="${MATTER_LAYER_RULES_MODULE:-local/gaia/rules.ts}"
bindings_file="${MATTER_LAYER_BINDINGS_FILE:-local/gaia/bindings.json}"
lock_file="${MATTER_LAYER_DEV_LIVE_LOCK:-/run/lock/matter-layer-dev-live.lock}"

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$service_name"; then
  sudo systemctl stop "$service_name"
fi

if [ ! -e "$lock_file" ]; then
  sudo install -m 0666 /dev/null "$lock_file"
elif [ ! -w "$lock_file" ]; then
  sudo chmod 0666 "$lock_file"
fi

exec 9<>"$lock_file"
flock 9

start_system_service() {
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl start --no-block "$service_name" || true
  fi
}
trap start_system_service EXIT

export MATTER_LAYER_RULES_MODULE="$rules_module"
if [ -f "$bindings_file" ]; then
  export MATTER_LAYER_BINDINGS_FILE="$bindings_file"
fi
if [ -z "${MATTER_LAYER_HA_TOKEN:-}" ] && [ -z "${MATTER_HA_TOKEN:-}" ] && [ -r /etc/secret/matter-reconcile.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/secret/matter-reconcile.env
  set +a
fi
export MATTER_LAYER_MATTER_ENABLED="${MATTER_LAYER_MATTER_ENABLED:-1}"
export MATTER_LAYER_MATTER_REMOTE_KEEPALIVE_ENABLED="${MATTER_LAYER_MATTER_REMOTE_KEEPALIVE_ENABLED:-1}"
export MATTER_LAYER_DRY_RUN="${MATTER_LAYER_DRY_RUN:-0}"
export MATTER_LAYER_PORT="${MATTER_LAYER_PORT:-3010}"
export MATTER_LAYER_WEB_DEV="${MATTER_LAYER_WEB_DEV:-1}"
state_home="${XDG_STATE_HOME:-${HOME:-$PWD/.state}/.local/state}"
export MATTER_LAYER_DB_PATH="${MATTER_LAYER_DB_PATH:-$state_home/matter-layer/dev-live.sqlite}"

./node_modules/.bin/tsx watch src/server.ts
