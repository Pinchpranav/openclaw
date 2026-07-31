#!/usr/bin/env bash
# lean-bootstrap.sh — Install + enable OpenClaw plugins on container start.
# Runs via OPENCLAW_DOCKER_INIT_SCRIPT (entrypoint.sh), before configure.js + gateway.
# Idempotent + graceful: a plugin failing never blocks gateway startup.
# No build step: OpenClaw's Jiti loader handles .ts source entries at runtime
# (https://docs.openclaw.ai/plugins/sdk-entrypoints — falls back to the TS source
# when no dist/*.js peer exists). Add `npm run build` before `plugins install`
# if a plugin ever needs compilation.

set -uo pipefail
LOG_PREFIX="[lean-bootstrap]"
PLUGINS_DIR="/app/plugins"

echo "${LOG_PREFIX} starting"

command -v openclaw >/dev/null 2>&1 || { echo "${LOG_PREFIX} WARN: openclaw CLI not on PATH; skipping"; exit 0; }
[ -d "${PLUGINS_DIR}" ] || { echo "${LOG_PREFIX} no ${PLUGINS_DIR}; nothing to do"; exit 0; }

shopt -s nullglob
for plugin_dir in "${PLUGINS_DIR}"/*/; do
  name="$(basename "${plugin_dir}")"
  [ -f "${plugin_dir}package.json" ] || { echo "${LOG_PREFIX} skip ${name} (no package.json)"; continue; }
  echo "${LOG_PREFIX} === ${name} ==="
  (
    cd "${plugin_dir}" || exit 1

    # 1) deps — skip if already installed (restarts). Full install so a future
    #    build step has typescript available. --legacy-peer-deps avoids npm
    #    auto-fetching the heavy `openclaw` peer from the registry; the host
    #    already provides the SDK (OpenClaw's Jiti alias map resolves it at
    #    runtime, and `plugins install --link` links node_modules/openclaw).
    #    Non-fatal: a plugin missing deps simply won't load (caught at verify).
    if [ -d node_modules ]; then
      echo "${LOG_PREFIX}   ${name}: node_modules exists, skip npm install"
    else
      echo "${LOG_PREFIX}   ${name}: npm install --legacy-peer-deps"
      npm install --legacy-peer-deps 2>&1 | sed 's/^/      /' || echo "${LOG_PREFIX}   ${name}: npm install FAILED (continuing)"
    fi

    # 2) register the plugin in-place (--link: runtime loads from this dir,
    #    where node_modules now lives). Idempotent: tolerate already-installed.
    echo "${LOG_PREFIX}   ${name}: openclaw plugins install --link"
    openclaw plugins install --link "${plugin_dir}" 2>&1 | sed 's/^/      /' \
      || echo "${LOG_PREFIX}   ${name}: plugins install returned non-zero (may already be installed)"

    # 3) enable. Idempotent: enabling an already-enabled plugin is tolerated.
    echo "${LOG_PREFIX}   ${name}: openclaw plugins enable ${name}"
    openclaw plugins enable "${name}" 2>&1 | sed 's/^/      /' \
      || echo "${LOG_PREFIX}   ${name}: plugins enable returned non-zero (may already be enabled)"

    echo "${LOG_PREFIX} === ${name} ready ==="
  ) || echo "${LOG_PREFIX} WARN: plugin ${name} step failed; continuing (gateway will still start)"
done

# 4) Ensure the tools allowlist in openclaw.json. lean-bootstrap owns the
#    allowlist keys (profile + alsoAllow) and wipes any stale `allow`/`deny`
#    left by earlier OPENCLAW_CONFIG_JSON runs — `allow` + `alsoAllow` together
#    are schema-rejected (config-tools docs), so clearing stale keys matters.
#    Sub-keys like `tools.web` (search/fetch provider config) are PRESERVED so
#    the compose can own them via OPENCLAW__tools__web__* env vars; configure.js
#    deep-merges those env vars on top after this write. Idempotent + graceful.
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
echo "${LOG_PREFIX} ensuring tools config in ${CONFIG_FILE}"
mkdir -p "${STATE_DIR}"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  cfg.tools = cfg.tools || {};
  delete cfg.tools.allow;
  delete cfg.tools.deny;
  cfg.tools.profile = "minimal";
  cfg.tools.alsoAllow = ["group:fs", "group:runtime", "group:web", "pi_read"];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log("[lean-bootstrap] tools config ensured:", JSON.stringify(cfg.tools));
' "${CONFIG_FILE}" 2>&1 | sed 's/^/      /' || echo "${LOG_PREFIX} WARN: tools config write failed (continuing)"

echo "${LOG_PREFIX} done"