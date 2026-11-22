#!/usr/bin/env bash
# ==============================================================================
# Vanill-IA OS — Universal Lightweight Bare-Metal Installer
# Compatible with: Debian 12/13, Ubuntu 22.04/24.04+ LTS, Raspberry Pi OS
# Docker Engine is NOT installed by default (1-click installable from WebOS UI).
#
# Lightweight install : curl -fsSL https://install.vanill-ia.com/install.sh | sudo bash
# With Docker Engine  : curl -fsSL https://install.vanill-ia.com/install.sh | sudo bash -s -- --with-docker
# Local .deb package  : sudo bash install.sh --local ./dist/vanill-ia-os_1.7.1_all.deb
# ==============================================================================
set -euo pipefail

GITHUB_REPO="${VANILLIA_GITHUB_REPO:-12it-be/Vanill-ia-OS}"
LOCAL_DEB=""
WITH_DOCKER=0
TMP_DIR="$(mktemp -d -t vanill-ia-install-XXXXXX)"

cleanup() {
    rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --with-docker)
            WITH_DOCKER=1
            shift
            ;;
        --local|-f)
            LOCAL_DEB="${2:-}"
            shift 2
            ;;
        *.deb)
            LOCAL_DEB="$1"
            shift
            ;;
        *)
            echo "[ERROR] Unknown option: $1" >&2
            echo "Usage: sudo bash install.sh [--with-docker] [--local path/to/vanill-ia-os_x.y.z_all.deb]" >&2
            exit 2
            ;;
    esac
done

if [[ "${EUID}" -ne 0 ]]; then
    echo "[ERROR] Please run this installer as root." >&2
    exit 1
fi

if [[ ! -r /etc/os-release ]]; then
    echo "[ERROR] /etc/os-release not found. Unsupported operating system." >&2
    exit 1
fi

# shellcheck source=/dev/null
. /etc/os-release

DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"
DISTRO_PRETTY="${PRETTY_NAME:-${DISTRO_ID}}"

if [[ "${DISTRO_ID}" != "debian" && "${DISTRO_ID}" != "ubuntu" && "${DISTRO_ID}" != "raspbian" ]] \
   && [[ "${DISTRO_LIKE}" != *"debian"* && "${DISTRO_LIKE}" != *"ubuntu"* ]]; then
    echo "[ERROR] Unsupported distribution: ${DISTRO_PRETTY}." >&2
    echo "Vanill-IA OS requires a Debian, Ubuntu, or Raspberry Pi OS system." >&2
    exit 1
fi

echo "=========================================================="
echo " Installing Vanill-IA OS on ${DISTRO_PRETTY}"
echo "=========================================================="

export DEBIAN_FRONTEND=noninteractive

echo "[1/4] Updating APT package index and installing base prerequisites..."
apt-get update -qq
apt-get install -y -qq \
    ca-certificates \
    curl \
    gnupg \
    apt-transport-https \
    lsb-release

caddy_in_apt() {
    local cand
    cand="$(apt-cache policy caddy 2>/dev/null | awk '/Candidate:/ {print $2}')"
    [[ -n "${cand}" && "${cand}" != "(none)" ]]
}

if ! command -v caddy >/dev/null 2>&1 && ! caddy_in_apt; then
    echo "[2/4] Adding official Caddy APT repository..."
    apt-get install -y -qq debian-keyring debian-archive-keyring
    install -m 0755 -d /usr/share/keyrings
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
    chmod 0644 /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
else
    echo "[2/5] Caddy package is available."
fi

if [[ "${WITH_DOCKER}" -eq 1 ]]; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "[+] --with-docker requested: installing Docker Engine & Compose..."
        if [[ "${DISTRO_ID}" == "debian" || "${DISTRO_ID}" == "ubuntu" ]] && [[ -n "${VERSION_CODENAME:-}" ]]; then
            install -m 0755 -d /etc/apt/keyrings
            curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" -o /etc/apt/keyrings/docker.asc
            chmod a+r /etc/apt/keyrings/docker.asc
            ARCH="$(dpkg --print-architecture)"
            echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DISTRO_ID} ${VERSION_CODENAME} stable" \
                > /etc/apt/sources.list.d/docker.list
            apt-get update -qq
            apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
                || apt-get install -y -qq docker.io
        else
            apt-get install -y -qq docker.io
            apt-get install -y -qq docker-compose-v2 2>/dev/null || apt-get install -y -qq docker-compose 2>/dev/null || true
        fi
        systemctl enable --now docker >/dev/null 2>&1 || true
    else
        echo "[+] Docker Engine is already installed ($(docker --version))."
    fi
fi

# Resolve .deb package (--local, VANILLIA_DEB_URL, GitHub Releases latest, or local build.sh)
DEB_TARGET=""
if [[ -n "${LOCAL_DEB}" ]]; then
    if [[ ! -f "${LOCAL_DEB}" ]]; then
        echo "[ERROR] Local .deb file not found: ${LOCAL_DEB}" >&2
        exit 1
    fi
    DEB_TARGET="$(realpath "${LOCAL_DEB}")"
    echo "[3/4] Using local package: ${DEB_TARGET}"
elif [[ -n "${VANILLIA_DEB_URL:-}" ]]; then
    echo "[3/4] Downloading package from ${VANILLIA_DEB_URL}..."
    DEB_TARGET="${TMP_DIR}/vanill-ia-os_latest_all.deb"
    curl -fL "${VANILLIA_DEB_URL}" -o "${DEB_TARGET}"
else
    SCRIPT_DIR=""
    if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    fi

    RELEASE_URL="$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
        | grep -Eo 'https://[^"]+_all\.deb' | head -n 1 || true)"

    if [[ -n "${RELEASE_URL}" ]]; then
        echo "[3/4] Downloading latest release from GitHub (${RELEASE_URL})..."
        DEB_TARGET="${TMP_DIR}/$(basename "${RELEASE_URL}")"
        curl -fL "${RELEASE_URL}" -o "${DEB_TARGET}"
    elif [[ -n "${SCRIPT_DIR}" && -x "${SCRIPT_DIR}/build.sh" ]]; then
        echo "[3/4] Building .deb package from local repository sources..."
        bash "${SCRIPT_DIR}/build.sh"
        DEB_TARGET="$(ls -1t "${SCRIPT_DIR}"/dist/vanill-ia-os_*_all.deb | head -n 1)"
    else
        echo "[ERROR] Could not resolve latest *_all.deb release from https://github.com/${GITHUB_REPO}/releases" >&2
        echo "Pass a local .deb package via: sudo bash install.sh --local ./vanill-ia-os_1.7.1_all.deb" >&2
        exit 1
    fi
fi

echo "[4/4] Installing ${DEB_TARGET}..."
apt-get install -y "${DEB_TARGET}"

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
SERVER_IP="${SERVER_IP:-127.0.0.1}"
SETUP_TOK=""
if [[ -f /var/lib/vanill-ia-os/data/setup.token ]]; then
    SETUP_TOK="$(tr -d '\r\n' < /var/lib/vanill-ia-os/data/setup.token)"
fi

# Read active ports configured by postinst in /etc/caddy/conf.d/vanill-ia-os.caddy
CONF_HTTP_PORT="8080"
CONF_HTTPS_PORT=""
if [[ -f /etc/caddy/conf.d/vanill-ia-os.caddy ]]; then
    PARSED_PORTS="$(php -r '
        $c = @file_get_contents($argv[1]) ?: "";
        $http = "8080"; $https = "";
        if (preg_match_all("/^([^\s{#][^{]*?)\s*\{([\s\S]*?)^\}/m", $c, $m, PREG_SET_ORDER)) {
            foreach ($m as $blk) {
                if (preg_match("/:([0-9]{2,5})\b/", trim($blk[1]), $pm)) {
                    if (preg_match("/^\s*tls\s+/m", $blk[2])) $https = $pm[1];
                    else $http = $pm[1];
                }
            }
        }
        echo $http . "|" . $https;
    ' /etc/caddy/conf.d/vanill-ia-os.caddy 2>/dev/null || echo "8080|8443")"
    CONF_HTTP_PORT="${PARSED_PORTS%%|*}"
    CONF_HTTPS_PORT="${PARSED_PORTS##*|}"
fi

echo ""
echo "=========================================================="
echo " Vanill-IA OS is installed and ready!"
echo "----------------------------------------------------------"
if [[ -n "${CONF_HTTPS_PORT}" ]]; then
    echo " HTTPS URL (Standalone PWA) : https://${SERVER_IP}:${CONF_HTTPS_PORT}"
fi
echo " Local HTTP URL             : http://${SERVER_IP}:${CONF_HTTP_PORT}"
if [[ -n "${SETUP_TOK}" ]]; then
    echo " First-Boot Setup Token     : ${SETUP_TOK}"
else
    echo " Retrieve Setup Token       : sudo vanill-ia-os setup-token"
fi
if ! command -v docker >/dev/null 2>&1; then
    echo " Mode                       : Lightweight Bare-Metal (Docker installable in 1 click from WebOS)"
fi
echo "=========================================================="
