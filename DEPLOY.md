# Deploy — AstraGPT

Frontend aur backend **ek saath** jaate hain. Auth contract dono taraf badla hai:
sirf backend deploy karoge to purana frontend har request par `401` dega.

---

## Pehli baar (ek hi baar chalana hai)

VPS par SSH karke:

```bash
# 1. Code
sudo mkdir -p /opt/astragpt && sudo chown -R "$USER" /opt/astragpt
git clone <your-repo-url> /opt/astragpt
cd /opt/astragpt

# 2. Docker + Node 20 + pm2 + nginx + certbot + sandbox images
sudo bash astra-backend/scripts/setup-vps.sh
```

Script idempotent hai — dobara chalane se kuch nahi tootega.

### `.env` copy karo

Local `.env` VPS par le jao (jo maine `JWT_SECRET` / `ADMIN_SECRET` generate kiye,
woh usme already hain):

```bash
scp astra-backend/.env user@vps:/opt/astragpt/astra-backend/.env
chmod 600 /opt/astragpt/astra-backend/.env
```

Verify:

```bash
cd /opt/astragpt/astra-backend && npm run check:env
```

`env OK` aana chahiye. Kuch missing hoga to naam batayega.

### TLS certificate

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d astragpt.in -d www.astragpt.in

sudo cp /opt/astragpt/astra-backend/nginx.conf \
        /etc/nginx/sites-available/astragpt
sudo ln -sf /etc/nginx/sites-available/astragpt /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` **pass hona zaroori hai** reload se pehle.

---

## Har deploy

```bash
cd /opt/astragpt && bash astra-backend/scripts/deploy.sh
```

Script khud: pull → `npm ci` dono taraf → backend tests → frontend build →
nginx validate → pm2 reload → health check. **Health fail hone par apne aap
previous commit par rollback** ho jata hai.

---

## Verify karne ke liye

```bash
curl -s https://astragpt.in/health                  # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' \
     https://astragpt.in/api/backend/v1/me          # 401  ← bina token, sahi
docker ps                                            # sandbox containers
pm2 logs astragpt --lines 50
```

`/v1/me` par `200` aaya to auth middleware galat hai — turant dekho.

---

## Kuch toot jaye to

```bash
pm2 logs astragpt --err --lines 100     # backend error
sudo nginx -t                            # nginx config
npm run check:env                        # missing env var
docker info                              # docker daemon
cd /opt/astragpt && git log --oneline -5 # kis commit par ho
```

Manual rollback:

```bash
cd /opt/astragpt && git reset --hard <previous-sha>
bash astra-backend/scripts/deploy.sh
```

---

## Deploy ke baad

**Sab users logged out ho jayenge.** `JWT_SECRET` naya hai, toh purane saare
token invalid. Ek baar dobara login karna padega — ye expected hai, aur zaroori
bhi, kyunki purana secret leak ho chuka tha.

---

## Abhi bhi pending (mere haath me nahi)

- **`AISUBSCRIPTION_API_KEY` rotate karo** — git history me hai.
- **`astragpt/src/lib/api.js:12` aur `:17`** — do provider keys browser bundle
  me ship hoti hain, koi bhi user DevTools se nikal sakta hai. Rotate karo, aur
  ideally frontend se hata kar backend proxy se bhejo.

Optional (inke bina feature fail-closed rehta hai, security issue nahi):
`NEXUSIFY_API_KEY` (auto-title/tags), `OPENAI_API_KEY` (voice),
`UPSTASH_REDIS_*` (shared rate limiting).
