# Deploying to Google Cloud (free e2-micro)

One always-free VM runs the navigator and Caddy (HTTPS) from `compose.yml`.
Your site stays where it is; its script tag points at this VM.

Run the `gcloud` commands from your laptop (install the Google Cloud CLI and
`gcloud auth login` first), and the rest on the VM.

## 1. Create the VM

```bash
gcloud compute instances create navigator \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-type=pd-standard --boot-disk-size=30GB \
  --tags=http-server,https-server
```

Every flag that matters for staying free:

- **`e2-micro` in `us-west1`, `us-central1` or `us-east1`.** Only those regions
  are in the free tier.
- **`--boot-disk-type=pd-standard`.** The free tier covers *standard* persistent
  disk; new VMs default to *balanced*, which is billed. 30 GB is the free limit.
- **`--tags=http-server,https-server`** opens ports 80 and 443 through the
  default firewall rules. Caddy needs both, 80 to get its certificate.

Open ports 80/443 if your project has no default firewall rules:

```bash
gcloud compute firewall-rules create allow-web --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
```

Note the external IP it prints. It survives reboots but **changes if you stop
and start the VM**, and your DNS record points at it.

## 2. DNS

Add an **A record** `nav.financefundamentals.app` → the VM's IP.

In Cloudflare, set it to **DNS only (grey cloud)**, not proxied. Proxied, every
visitor reaches the VM from a Cloudflare address, so they would all share one
rate limit.

## 3. Set up the VM

```bash
gcloud compute ssh navigator --zone=us-central1-a
```

On the VM:

```bash
# 1 GB of RAM is enough to run, tight for building the image -- add swap
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker, from Docker's own installer
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit
```

## 4. Ship the code

From your laptop, in this repo (only committed files; `.env` stays behind):

```bash
git archive --format=tar.gz -o /tmp/navigator.tgz HEAD
gcloud compute scp /tmp/navigator.tgz navigator:~ --zone=us-central1-a
```

On the VM:

```bash
mkdir -p navigator && tar -xzf navigator.tgz -C navigator && cd navigator
nano .env
```

`.env` on the VM:

```
LLM_API_KEY=<AI Studio key>
NAV_ADMIN_KEY=<long random string>
ALLOWED_ORIGINS=finance-calculator-tools=https://financefundamentals.app https://www.financefundamentals.app
NAV_DOMAIN=nav.financefundamentals.app
```

```bash
chmod 600 .env
docker compose up -d --build     # first build takes a while on an e2-micro
```

Check: `https://nav.financefundamentals.app/` should show the status page. If
it doesn't, `docker compose logs caddy` usually says why (most often DNS not
pointing here yet, or port 80 closed).

## 5. Index your site

```bash
docker compose exec -u node app node crawl.ts finance-calculator-tools https://financefundamentals.app/
```

Keep `-u node`: `exec` otherwise runs as root, and a crawl as root can leave
the database owned by root, where the server can no longer write to it.

### Signed-in pages too

`compose.yml` mounts `auth.json` read-only, so the file must be on the VM
before `docker compose up` (missing, Docker creates an empty directory there).

On your laptop, sign in with a test account (email/password; Google sign-in
often blocks automated browsers), then press Enter in the terminal:

```bash
node login.ts https://financefundamentals.app
gcloud compute scp auth.json navigator:~/navigator/ --zone=us-central1-a
rm auth.json    # a live login; don't keep extra copies
```

On the VM, hand it to the container's user (uid 1000) and crawl with it:

```bash
sudo chown 1000:1000 auth.json && sudo chmod 600 auth.json
docker compose up -d
docker compose exec -u node app node crawl.ts finance-calculator-tools https://financefundamentals.app/ --auth /app/auth.json
```

The crawl ends with "(N only when signed in)". If it warns the session has
expired, repeat these steps.

## 6. Add the widget to your site

```html
<script async src="https://nav.financefundamentals.app/nav.js" data-site="finance-calculator-tools"></script>
```

## Updating

Repeat step 4, then `docker compose up -d --build`. The index and cache live
in the `navdata` volume and survive rebuilds.

## Watch the bill

The free tier includes 1 GB of outbound data a month. The widget script is
7.5 KB gzipped and cached by browsers for an hour, so that covers well over
100,000 page views. Check **Billing → Reports** after the first day anyway:
anything above $0.00 means a setting above is off.

## Automatic deploys (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push to `main`: tests first, then
it uploads the code to the VM over SSH and runs `docker compose up -d --build`.
It logs in as a dedicated `deploy` user created by hand on the VM. Google's
guest agent manages SSH keys for accounts it created from metadata, and can
remove keys added to those by hand; it leaves other accounts alone.

One-time setup. Do it **before** merging the workflow, or the first deploy fails
(harmlessly; re-run it from the Actions tab afterwards).

**1. A key just for GitHub** (laptop):

```bash
ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f ~/.ssh/navigator-deploy
cat ~/.ssh/navigator-deploy.pub      # copy this line for step 2
```

**2. The `deploy` user, and the app moved to `/opt/navigator`** (VM):

```bash
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /home/deploy/.ssh
echo 'PASTE THE .pub LINE HERE' | sudo tee /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh && sudo chmod 600 /home/deploy/.ssh/authorized_keys

cd ~/navigator && docker compose down         # stops it; the data volume stays
sudo mv ~/navigator /opt/navigator
sudo chown -R deploy:deploy /opt/navigator
sudo chown 1000:1000 /opt/navigator/auth.json  # the container's user, as before
cd /opt/navigator && sudo -u deploy docker compose up -d
```

The folder is still called `navigator`, so Compose finds the same data volume
and the index and cache carry over.

Being in the `docker` group is effectively root on this VM, so treat the
private key as a root credential.

**3. Pin the VM's identity** (laptop):

```bash
ssh-keyscan -t ed25519 nav.financefundamentals.app
```

Compare its fingerprint with the VM's own
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the VM) before trusting
it. The workflow refuses to deploy to any machine that doesn't match.

**4. GitHub secrets.** Repo → **Settings → Secrets and variables → Actions →
New repository secret**:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | the whole of `~/.ssh/navigator-deploy` (the private key) |
| `DEPLOY_KNOWN_HOSTS` | the line printed in step 3 |

Then delete the private key from your laptop, or keep it only in a password
manager. The Gemini key and the rest of `.env` stay on the VM; GitHub never
sees them.

The deploy connects to `nav.financefundamentals.app` on port 22, so that DNS
record has to stay **DNS only**: a Cloudflare-proxied name doesn't carry SSH.
