#!/usr/bin/env bash
# ==============================================================================
# Vanill-IA OS — Universal One-Liner Installer
# Compatible with: Debian 12/13, Ubuntu 22.04/24.04+ LTS, Raspberry Pi OS
#
# Remote usage : curl -fsSL https://install.vanill-ia.com | sudo bash
# Local usage  : sudo bash install.sh --local ./dist/vanill-ia-os_1.6.0_all.deb
# ==============================================================================
set -euo pipefail

GITHUB_REPO="12it-be/Vanill-ia-OS"
LOCAL_DEB=""
TMP_DIR="$(mktemp -d -t vanill-ia-install-XXXXXX)"

cleanup() {
    rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
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
            echo "Usage: sudo bash install.sh [--local path/to/vanill-ia-os_x.y.z_all.deb]" >&2
            exit 2
            ;;
    esac
done

if [[ "${EUID}" -ne 0 ]]; then
    echo "[ERROR] Please run this installer as root (e.g. curl -fsSL https://install.vanill-ia.com | sudo bash)." >&2
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

echo "[1/5] Updating APT package index and installing base prerequisites..."
apt-get update -qq
apt-get install -y -qq \
    ca-certificates \
    curl \
    gnupg \
    apt-transport-https \
    lsb-release

# Automatically add official Caddy APT repository if `caddy` is not installed and not available in APT
caddy_in_apt() {
    local cand
    cand="$(apt-cache policy caddy 2>/dev/null | awk '/Candidate:/ {print $2}')"
    [[ -n "${cand}" && "${cand}" != "(none)" ]]
}

if ! command -v caddy >/dev/null 2>&1 && ! caddy_in_apt; then
    echo "[2/5] Adding official Caddy APT repository..."
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

# Install Docker Engine if absent
if ! command -v docker >/dev/null 2>&1; then
    echo "[3/5] Installing Docker Engine & Compose..."
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
else
    echo "[3/5] Docker Engine already installed ($(docker --version))."
fi

# Resolve .deb package (--local, VANILLIA_DEB_URL, GitHub Releases latest, or local build.sh)
DEB_TARGET=""
if [[ -n "${LOCAL_DEB}" ]]; then
    if [[ ! -f "${LOCAL_DEB}" ]]; then
        echo "[ERROR] Local .deb file not found: ${LOCAL_DEB}" >&2
        exit 1
    fi
    DEB_TARGET="$(realpath "${LOCAL_DEB}")"
    echo "[4/5] Using local package: ${DEB_TARGET}"
elif [[ -n "${VANILLIA_DEB_URL:-}" ]]; then
    echo "[4/5] Downloading package from ${VANILLIA_DEB_URL}..."
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
        echo "[4/5] Downloading latest release from GitHub (${RELEASE_URL})..."
        DEB_TARGET="${TMP_DIR}/$(basename "${RELEASE_URL}")"
        curl -fL "${RELEASE_URL}" -o "${DEB_TARGET}"
    elif [[ -n "${SCRIPT_DIR}" && -x "${SCRIPT_DIR}/build.sh" ]]; then
        echo "[4/5] Building .deb package from local repository sources..."
        bash "${SCRIPT_DIR}/build.sh"
        DEB_TARGET="$(ls -1t "${SCRIPT_DIR}"/dist/vanill-ia-os_*_all.deb | head -n 1)"
    else
        echo "[ERROR] Could not resolve latest *_all.deb release from https://github.com/${GITHUB_REPO}/releases" >&2
        echo "Pass a local .deb package via: sudo bash install.sh --local ./vanill-ia-os_1.6.0_all.deb" >&2
        exit 1
    fi
fi

echo "[5/5] Installing ${DEB_TARGET} and resolving system dependencies..."
apt-get install -y "${DEB_TARGET}"

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
SERVER_IP="${SERVER_IP:-127.0.0.1}"
SETUP_TOK=""
if [[ -f /var/lib/vanill-ia-os/data/setup.token ]]; then
    SETUP_TOK="$(tr -d '\r\n' < /var/lib/vanill-ia-os/data/setup.token)"
fi

echo ""
echo "=========================================================="
echo " Vanill-IA OS is installed and ready!"
echo "----------------------------------------------------------"
echo " HTTPS URL (Standalone PWA) : https://${SERVER_IP}:8443"
echo " Local HTTP URL             : http://${SERVER_IP}:8080"
if [[ -n "${SETUP_TOK}" ]]; then
    echo " First-Boot Setup Token     : ${SETUP_TOK}"
else
    echo " Retrieve Setup Token       : sudo vanill-ia-os setup-token"
fi
echo "=========================================================="
