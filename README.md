# Vanill-IA OS

**Vanill-IA OS** is an ultra-lightweight, zero-bloat, open-source WebOS designed to administer any **Debian 12/13**, **Ubuntu 22.04/24.04+ LTS**, or **Raspberry Pi OS** server (VPS, mini-PC, Proxmox VM, home NAS, or bare-metal server) as an installable **Progressive Web App (PWA)**.

<img width="1893" height="862" alt="01-desktop" src="https://github.com/user-attachments/assets/6c8ab9af-b775-4a2a-bbd9-9ebff2f8a127" />


---

## Quick One-Liner Install

```bash
# Lightweight bare-metal install (no Docker overhead; Docker installable in 1 click from UI):
curl -fsSL https://install.vanill-ia.com/install.sh | sudo bash

# Optional: install with Docker Engine & Compose pre-configured:
curl -fsSL https://install.vanill-ia.com/install.sh | sudo bash -s -- --with-docker
```

---

## Key Capabilities

- **Responsive Multi-Window Desktop & Mobile PWA** :
  - Multi-window workspace with 8-way resize, Edge-Snap, automatic off-screen window recovery (`4K → 1080p`), Dock context menu (**Center Window / Close**), **Close All** reset, and freely reorderable Drag & Drop desktop icons.
  - Built-in **i18n (`English` default + persistent per-user `Français`)** with live language switching without closing open windows.
- **Hot-Loadable Plugin Architecture (`/var/lib/vanill-ia-os/apps/[app]/manifest.json`)** :
  - Drop a plugin folder with `manifest.json` (`"launchMode": "window"` sandboxed iframe or `"launchMode": "external"` new tab) — zero `.deb` rebuild required.
- **Docker, Compose Stacks, App Store, Official Docker Hub Search & Caddy Proxy** :
  - Transparent `docker-compose.yml` management in `/opt/vanill-ia/stacks/`, online-syncable curated App Store, live official **Docker Hub** repository & tag search with visual Ports/Volumes/Env Compose builder, live container metrics/logs/`docker exec`, and 2-click HTTPS Caddy subdomain routing.
- **System Administration, Files & Ephemeral SMB/CIFS Mount** :
  - Live **Resource Monitor** & SMART health, **System Settings** (Storage, Samba, Tailscale, UFW, Fail2ban, Systemd, APT), visual **Cron Scheduler**, **Files** explorer (Drag & Drop upload, Zip/Unzip, `chmod`/`chown`, media preview), multi-tab **Code Editor**, **Markdown Notes**, and interactive **Terminal**.
  - Native **Mount** app for remote SMB/CIFS shares using ephemeral `/tmp/.smb-cred-XXXX` (`0600`) immediately `unlink`ed after `mount` (**zero persistent secrets**).
  - Built-in **Public File Sharing (`/share.php`)**: share any server file via an unauthenticated cryptographic link with optional password protection, expiration time, max-download limit, and 8 KB chunked streaming.
  - **UI Web Shortcut Creator**: create custom desktop & `Ctrl+K` shortcuts for any `http(s)://` URL opening in a new tab, internal sandboxed window, or directly inside the isolated VPS Chromium browser.
- **Native Isolated Web Browser (Remote Browser Isolation — 0 MB RAM at rest)** :
  - On-demand VNC (`:99`) + `openbox` + `chromium` + `noVNC` running under unprivileged `vanill-ia-browser`, protected behind Caddy `forward_auth` (`/browser/*`), dynamic `resize=remote` scaling, titlebar **Reset Session**, and automatic teardown + profile wipe on window close.
- **Native SysAdmin AI Layer (Vanill-IA)** :
  - Local **Ollama** + BYOK (**Google Gemini 3.8 Flash**, OpenRouter, OpenAI, Anthropic) with zero arbitrary parameter clamping and 1-click contextual log diagnostics.

---

## Build & Local Installation

```bash
# Build natively on Debian / Ubuntu via dpkg-deb:
bash build.sh 1.7.1

# Or build portably via Node.js:
node build-deb.mjs 1.7.1

# Install a local .deb package:
sudo bash install.sh --local ./dist/vanill-ia-os_1.7.1_all.deb
sudo caddy validate --config /etc/caddy/Caddyfile
```
<img width="auto" height="800" alt="Screenshot_2026-11-24-00-16-59-705_com microsoft emmx" src="https://github.com/user-attachments/assets/a7cdd59b-0a65-47b7-8238-10b75018d590" />


### Server CLI Recovery Commands
```bash
sudo vanill-ia-os status                    # Daemon & Setup Wizard status
sudo vanill-ia-os setup-token               # Print first-boot Setup Token (WAN/VPS)
sudo vanill-ia-os reset-2fa <username>      # Emergency 2FA TOTP reset
sudo vanill-ia-os unlock-ip all             # Clear SQLite rate-limiting lockouts
sudo vanill-ia-browser-ctl status           # Check isolated Web Browser state & RAM
```
