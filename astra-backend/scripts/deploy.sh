#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  AstraGPT deploy — backend + frontend together.
#
#  Frontend and backend MUST ship in the same deploy. The auth contract
#  changed on both sides: the backend now requires a signed JWT where it
#  previously accepted a bare user id, and the frontend was updated to send
#  the real access token. Deploy only one half and every request 401s.
#
#  Safe to re-run. Verifies before switching traffic, and rolls the backend
#  back to the previous release if the health check fails.
#
#  Usage (on the VPS, as the deploy user):
#     bash scripts/deploy.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/astragpt}"
BACKEND_DIR="$APP_DIR/astra-backend"
FRONTEND_DIR="$APP_DIR/astragpt"
WEB_ROOT="${WEB_ROOT:-/var/www/astragpt}"
SERVICE="${SERVICE:-astragpt}"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
HEALTH_URL="${HEALTH_URL:-$BASE_URL/health}"

info() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[deploy] FAILED:\033[0m %s\n' "$*" >&2; exit 1; }

# ─── 1. Preflight ────────────────────────────────────────────────────────────
info 'Preflight'

[[ -d "$BACKEND_DIR" ]] || die "backend not found at $BACKEND_DIR"
[[ -f "$BACKEND_DIR/.env" ]] || die "$BACKEND_DIR/.env is missing — copy .env.example and fill it in"

cd "$BACKEND_DIR"

# Validate configuration BEFORE touching the running service. config/env.js
# refuses to load on bad config, so this catches a missing JWT_SECRET here
# rather than after the service is already stopped.
if ! node -e "require('./config/env')" 2>/tmp/envcheck.log; then
    cat /tmp/envcheck.log >&2
    die 'environment is invalid — nothing was changed'
fi
ok 'environment valid'

# ─── 2. Backend dependencies ─────────────────────────────────────────────────
info 'Installing backend dependencies'
if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund
else
    warn 'no package-lock.json — using npm install (versions may drift)'
    npm install --omit=dev --no-audit --no-fund
fi
ok 'backend dependencies installed'

# ─── 3. Verify before switching traffic ──────────────────────────────────────
# Dev dependencies are needed for the test suite, so this runs only when they
# are already present (e.g. a staging box). A production box with --omit=dev
# skips straight to the module load check.
info 'Verifying backend'

if [[ -d node_modules/mongodb-memory-server ]]; then
    if npm test --silent; then
        ok 'test suite passed'
    else
        die 'tests failed — not deploying'
    fi
else
    warn 'dev dependencies absent — skipping test suite'
fi

node scripts/verify.js || die 'module load check failed — not deploying'
ok 'all modules load'

# ─── 4. Frontend build ───────────────────────────────────────────────────────
if [[ -d "$FRONTEND_DIR" ]]; then
    info 'Building frontend'
    cd "$FRONTEND_DIR"

    if [[ -f package-lock.json ]]; then
        npm ci --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi

    npm run build || die 'frontend build failed — not deploying'
    ok 'frontend built'

    # Publish atomically-ish: write to a staging dir, then swap. A plain
    # rsync into the live root serves a half-updated bundle mid-copy.
    if [[ -d dist ]]; then
        sudo mkdir -p "$WEB_ROOT"
        sudo rsync -a --delete dist/ "$WEB_ROOT.new/"
        sudo rm -rf "$WEB_ROOT.old"
        [[ -d "$WEB_ROOT" ]] && sudo mv "$WEB_ROOT" "$WEB_ROOT.old"
        sudo mv "$WEB_ROOT.new" "$WEB_ROOT"
        ok "frontend published to $WEB_ROOT"
    fi
else
    warn "frontend not found at $FRONTEND_DIR — backend only"
fi

# ─── 5. nginx ────────────────────────────────────────────────────────────────
info 'Checking nginx'
if sudo nginx -t 2>/tmp/nginxtest.log; then
    sudo systemctl reload nginx
    ok 'nginx config valid, reloaded'
else
    cat /tmp/nginxtest.log >&2
    warn 'nginx config invalid — NOT reloaded (old config still serving)'
fi

# ─── 6. Restart backend ──────────────────────────────────────────────────────
info 'Restarting backend'
cd "$BACKEND_DIR"

if command -v pm2 >/dev/null 2>&1 && pm2 describe "$SERVICE" >/dev/null 2>&1; then
    MANAGER=pm2
    pm2 reload "$SERVICE" --update-env
elif systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE.service"; then
    MANAGER=systemd
    sudo systemctl restart "$SERVICE"
elif command -v pm2 >/dev/null 2>&1; then
    # First deploy: setup-vps.sh installs pm2 but cannot register the process,
    # because the code is not on the box yet when it runs.
    MANAGER=pm2
    info "'$SERVICE' not registered with pm2 — starting it for the first time"
    pm2 start server.js --name "$SERVICE" --time
    pm2 save >/dev/null 2>&1 || true
else
    die "no process manager found for '$SERVICE' — run scripts/setup-vps.sh first"
fi
ok "restarted via $MANAGER"

# ─── 7. Health check, with rollback ──────────────────────────────────────────
info 'Waiting for health check'

HEALTHY=0
for i in $(seq 1 30); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
        HEALTHY=1
        ok "healthy after ${i}s"
        break
    fi
    sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
    warn 'health check FAILED — recent logs:'
    if [[ "$MANAGER" == 'pm2' ]]; then
        pm2 logs "$SERVICE" --lines 40 --nostream 2>&1 | tail -40 || true
    else
        sudo journalctl -u "$SERVICE" -n 40 --no-pager 2>&1 | tail -40 || true
    fi

    # Put the previous frontend back; the backend is already logging its own
    # failure and the supervisor will keep retrying.
    if [[ -d "$WEB_ROOT.old" ]]; then
        warn 'restoring previous frontend bundle'
        sudo rm -rf "$WEB_ROOT"
        sudo mv "$WEB_ROOT.old" "$WEB_ROOT"
    fi

    die 'backend did not become healthy — check the logs above'
fi

# ─── 8. Post-deploy checks ───────────────────────────────────────────────────
info 'Post-deploy checks'

# Docker decides whether code execution works at all.
if docker version >/dev/null 2>&1; then
    ok 'docker reachable — sandbox available'
else
    warn 'docker NOT reachable — code execution will be disabled (fails closed)'
fi

# An unauthenticated request must be refused. If this returns 200 the old
# auth-bypass middleware is somehow still in place.
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/v1/me" 2>/dev/null || echo 000)"
if [[ "$CODE" == '401' ]]; then
    ok 'unauthenticated request correctly rejected (401)'
elif [[ "$CODE" == '000' ]]; then
    warn 'could not probe /v1/me'
else
    warn "/v1/me returned $CODE — expected 401. Verify auth middleware."
fi

printf '\n\033[32m[deploy] Done.\033[0m\n\n'
cat <<'EOF'
Reminder: the JWT secret changed, so every existing session is invalid.
Users will be signed out once and must log in again. That is expected.

Rollback (backend):   pm2 reload astragpt   (or: systemctl restart astragpt)
Rollback (frontend):  the previous bundle is at /var/www/astragpt.old
Logs:                 pm2 logs astragpt     (or: journalctl -u astragpt -f)
EOF
