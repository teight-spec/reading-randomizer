#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_DATA="${SUIYUE_USER_DATA_DIR:-${ROOT}-userdata-verify}"
LOG_FILE="${SUIYUE_LOG_FILE:-/tmp/rr-pr1-isolated.log}"

unset GROQ_API_KEY DEEPL_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY \
  GOOGLE_CLOUD_TRANSLATE_API_KEY GOOGLE_TRANSLATE_API_KEY LIBRETRANSLATE_URL \
  2>/dev/null || true
export READER_DISABLE_BACKGROUND_WARMUP=1

ELECTRON_BIN="$(node "$ROOT/scripts/ensure-suiyue-electron-bundle.js")"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Isolated Electron binary is missing: $ELECTRON_BIN" >&2
  exit 1
fi

exec "$ELECTRON_BIN" --user-data-dir="$USER_DATA" "$ROOT" "$@"
