#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  One-time VPS provisioning for the AstraGPT backend.
#
#  Installs Docker (required by the code-execution sandbox), Node 20, pm2,
#  nginx and certbot, then pre-pulls the sandbox images so the first user
#  request does not pay the pull cost and time out.
#
#  Safe to re-run: every step checks for what it installs first.
#
#  Usage (as root, or a user with sudo):
#      sudo bash scripts/setup-vps.sh
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# Images must match config/env.js SANDBOX_IMG_* defaults.
SANDBOX_IMAGES=(
    "python:3.12-slim"
    "node:20-alpine"
    "alpine:3.20"
)

# The Linux user the backend process runs as. It needs docker access.
APP_USER="${APP_USER:-astra}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash scripts/setup-vps.sh"

# ─── 1. Base packages ────────────────────────────────────────────────────────
log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw >/dev/null
ok "curl, ca-certificates, gnupg, git, ufw"

# ─── 2. Docker ───────────────────────────────────────────────────────────────
# The sandbox is the security boundary for user-submitted code. Without Docker
# the backend refuses to execute anything (it fails closed, never falls back to
# running code on the host).
log "Docker"
if command -v docker >/dev/null 2>&1; then
    ok "already installed ($(docker --version))"
else
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh >/dev/null
    rm -f /tmp/get-docker.sh
    ok "installed ($(docker --version))"
fi

systemctl enable --now docker >/dev/null 2>&1 || true
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
    || die "Docker daemon is not responding. Check: systemctl status docker"
ok "daemon running"

# ─── 3. Application user ─────────────────────────────────────────────────────
log "Application user: $APP_USER"
if id "$APP_USER" >/dev/null 2>&1; then
    ok "exists"
else
    useradd --create-home --shell /bin/bash "$APP_USER"
    ok "created"
fi

# NOTE: membership in the docker group is equivalent to root on this host —
# anyone who can talk to the Docker socket can mount the filesystem. This is
# how the sandbox has to work (the backend shells out to `docker run`), but it
# means $APP_USER must be treated as a privileged account: no shared logins,
# no reusing it for anything else.
usermod -aG docker "$APP_USER"
ok "added to docker group (see the note in this script about what that grants)"

# ─── 4. Sandbox images ───────────────────────────────────────────────────────
log "Sandbox images"
for image in "${SANDBOX_IMAGES[@]}"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
        ok "$image (cached)"
    else
        printf '    pulling %s ... ' "$image"
        if docker pull -q "$image" >/dev/null 2>&1; then
            printf '\033[1;32mdone\033[0m\n'
        else
            printf '\033[1;31mfailed\033[0m\n'
            warn "$image could not be pulled — that language will not run"
        fi
    fi
done

# Prove isolation actually works rather than assuming it.
log "Sandbox smoke test"
if out=$(docker run --rm --network none --memory 128m --cpus 0.5 \
            --cap-drop ALL --security-opt no-new-privileges --read-only \
            --user 1000:1000 python:3.12-slim \
            python -c 'print("sandbox-ok")' 2>&1); then
    [[ "$out" == *sandbox-ok* ]] && ok "container ran with no network, non-root, read-only rootfs" \
                                || warn "unexpected output: $out"
else
    warn "smoke test failed — code execution will not work:"
    printf '      %s\n' "$out"
fi

# ─── 5. Node 20 ──────────────────────────────────────────────────────────────
log "Node.js"
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" =~ ^v(2[0-9]|[3-9][0-9]) ]]; then
    ok "already installed ($(node -v))"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    ok "installed ($(node -v))"
fi

# ─── 6. pm2 ──────────────────────────────────────────────────────────────────
# pm2 restarts the process on crash and on reboot. The backend has a graceful
# shutdown path (SIGTERM drains in-flight SSE streams before exiting), which
# pm2 triggers correctly.
log "pm2"
if command -v pm2 >/dev/null 2>&1; then
    ok "already installed ($(pm2 -v))"
else
    npm install -g pm2 >/dev/null 2>&1
    ok "installed ($(pm2 -v))"
fi
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || true
ok "configured to start on boot"

# ─── 7. nginx + certbot ──────────────────────────────────────────────────────
log "nginx + certbot"
apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null
ok "installed"

mkdir -p /var/www/astragpt /var/www/certbot
chown -R "$APP_USER:$APP_USER" /var/www/astragpt
ok "/var/www/astragpt  (frontend build target)"
ok "/var/www/certbot   (ACME challenge webroot)"

# ─── 8. Firewall ─────────────────────────────────────────────────────────────
# Port 4000 is deliberately NOT opened: the backend must only be reachable
# through nginx, which terminates TLS. Exposing it directly would serve every
# bearer token over plaintext HTTP.
log "Firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ok "SSH + HTTP/HTTPS allowed; port 4000 stays internal"

# ─── Done ────────────────────────────────────────────────────────────────────
cat <<EOF

$(printf '\033[1;32m')════════════════════════════════════════════════════════════$(printf '\033[0m')
 Provisioning complete.
$(printf '\033[1;32m')════════════════════════════════════════════════════════════$(printf '\033[0m')

 Docker  $(docker --version | cut -d, -f1)
 Node    $(node -v)
 pm2     $(pm2 -v)
 nginx   $(nginx -v 2>&1 | cut -d/ -f2)

 Next: DEPLOY.md, section 2 (TLS certificate) onward.

 One caveat worth knowing: '$APP_USER' is now in the docker group, which on
 any Linux host is effectively root access. Keep it to this application.

EOF
