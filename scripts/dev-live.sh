#!/usr/bin/env bash
set -euo pipefail

service_name="${MATTER_LAYER_SYSTEM_SERVICE:-matter-layer.service}"
rules_module="${MATTER_LAYER_RULES_MODULE:-local/gaia/rules.ts}"
bindings_file="${MATTER_LAYER_BINDINGS_FILE:-local/gaia/bindings.json}"

service_was_active=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$service_name"; then
  service_was_active=1
  sudo systemctl stop "$service_name"
fi

restore_service() {
  if [ "$service_was_active" -eq 1 ]; then
    sudo systemctl start "$service_name" || true
  fi
}
trap restore_service EXIT INT TERM

export MATTER_LAYER_RULES_MODULE="$rules_module"
if [ -f "$bindings_file" ]; then
  export MATTER_LAYER_BINDINGS_FILE="$bindings_file"
fi
export MATTER_LAYER_MATTER_ENABLED="${MATTER_LAYER_MATTER_ENABLED:-1}"
export MATTER_LAYER_DRY_RUN="${MATTER_LAYER_DRY_RUN:-0}"

./node_modules/.bin/tsx src/server.ts
