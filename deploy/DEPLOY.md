# Deploy TradeLock to AWS Lightsail (Mumbai)

The result is one Ubuntu server running two containers:

- **TradeLock** (the app)
- **Caddy**, which gets the HTTPS certificate automatically

Cost is roughly the price of the smallest Lightsail plans, a few dollars a month. Check current pricing in the console.

## 1. Create the server (AWS console, about 5 minutes)

1. Open **Lightsail → Create instance**.
   - **Region:** Mumbai (`ap-south-1`). It is close to your users and to Dhan's API.
   - **Platform:** Linux/Unix. **Blueprint:** OS only → **Ubuntu 24.04 LTS**.
   - **Plan:** 1 GB RAM minimum. 2 GB is more comfortable.
   - **Name:** `tradelock-prod`.
2. **Networking → Create static IP**, and attach it to the instance.
3. **Networking → IPv4 firewall**: allow **HTTP 80** and **HTTPS 443**. SSH 22 is open by default; restrict it to your IP if you can.
4. **Snapshots**: enable **automatic daily snapshots**. This is your disaster-recovery copy.
5. Download the SSH key from **Account → SSH keys** (`LightsailDefaultKey-ap-south-1.pem`).

## 2. Point the domain at the server

At your domain registrar, create:

| Type | Name | Value |
|---|---|---|
| A | `@` | your static IP |
| A | `www` | your static IP |

Wait until `nslookup tradelock.in` returns the static IP. This usually takes a few minutes and occasionally up to an hour. HTTPS will not issue until DNS points to the server.

## 3. Copy the code to the server

From the project folder on your PC (PowerShell or Git Bash):

```bash
scp -i LightsailDefaultKey-ap-south-1.pem -r package.json package-lock.json Dockerfile .dockerignore server web deploy ubuntu@YOUR_IP:~/tradelock/
```

(Later, using a Git repo and `git pull` on the server is cleaner.)

## 4. Set up and launch

```bash
ssh -i LightsailDefaultKey-ap-south-1.pem ubuntu@YOUR_IP
cd ~/tradelock/deploy
chmod +x *.sh
./setup-server.sh
exit                                  # log out so the docker group applies
```

Then reconnect and launch:

```bash
ssh -i LightsailDefaultKey-ap-south-1.pem ubuntu@YOUR_IP
cd ~/tradelock/deploy
cp .env.example .env
openssl rand -base64 48               # copy this output
nano .env                             # paste it as APP_SECRET, check DOMAIN and PUBLIC_URL
./deploy.sh
```

Open https://tradelock.in. Caddy fetches the certificate on the first request, which takes a few seconds.

**Save `APP_SECRET` in a password manager.** If it is lost, every stored broker token becomes unreadable.

## Updating

Copy the changed files with `scp` (or `git pull`), then run:

```bash
cd ~/tradelock/deploy && ./deploy.sh
```

The database lives in a Docker volume, so it survives rebuilds.

## Day-to-day

| Task | Command (in `~/tradelock/deploy`) |
|---|---|
| Logs | `docker compose logs -f app` |
| Status | `docker compose ps` |
| Restart | `docker compose restart app` |
| Manual backup | `./backup.sh` (daily at 16:30 IST is already scheduled; copies go to `~/backups`) |
| Restore | `docker compose stop app`, `gunzip` a backup, `docker compose cp file.db app:/app/data/tradelock.db`, `docker compose start app` |

**Off-site backups (recommended):**

1. Create an S3 bucket in ap-south-1.
2. Install the AWS CLI on the server, with credentials that can only write to that bucket.
3. Add `S3_BUCKET=your-bucket` before the command in the crontab line.

## Before real traders use it

- Test the Dhan connection with your own live account: positions loading, a small exit, and the emergency stop.
- Add uptime monitoring that alerts you when `https://tradelock.in/api/health` fails. UptimeRobot or Lightsail alarms both work.
- Keep it on one instance. The app holds live state in memory, and a load balancer with two instances would break it (see the README).

## Token keeper (Dhan token renewal)

The `tokenkeeper` service renews every user's Dhan access token at **06:00 and 18:00 IST**
(and once at start-up). Tokens that would expire before the next run are renewed with Dhan's
`RenewToken` API; already-expired tokens cannot be renewed, so the user is asked to reconnect.

| Task | Command (in `~/tradelock/deploy`) |
|---|---|
| Logs | `docker compose logs -f tokenkeeper` |
| Run a renewal pass now | `docker compose exec tokenkeeper node server/src/workers/token-renewer.js --once` |
