#!/usr/bin/env bash
# ==============================================================================
# Vanill-IA OS — Automated Debian Package (.deb) Builder
# Target: Debian 12 (Bookworm) / Debian 13 (Trixie) — Architecture: all
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_SRC="${SCRIPT_DIR}/package"
DIST_DIR="${SCRIPT_DIR}/dist"
BUILD_ROOT="$(mktemp -d -t vanill-ia-os-build-XXXXXX)"

cleanup() {
    rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

if [[ ! -d "${PACKAGE_SRC}/DEBIAN" ]]; then
    echo "[ERREUR] Dossier source introuvable : ${PACKAGE_SRC}/DEBIAN" >&2
    exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "[ERREUR] 'dpkg-deb' est requis pour compiler le paquet .deb (exécutez sous Debian/Ubuntu/WSL)." >&2
    exit 1
fi

PKG_NAME="$(awk -F': ' '/^Package:/ {print $2}' "${PACKAGE_SRC}/DEBIAN/control" | tr -d '\r\n')"
PKG_VERSION="${1:-$(awk -F': ' '/^Version:/ {print $2}' "${PACKAGE_SRC}/DEBIAN/control" | tr -d '\r\n')}"
PKG_ARCH="$(awk -F': ' '/^Architecture:/ {print $2}' "${PACKAGE_SRC}/DEBIAN/control" | tr -d '\r\n')"

echo "=========================================================="
echo " Construction de ${PKG_NAME} v${PKG_VERSION} (${PKG_ARCH})"
echo "=========================================================="

STAGING_DIR="${BUILD_ROOT}/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH}"
mkdir -p "${STAGING_DIR}" "${DIST_DIR}"

# Copie propre de l'arborescence package/
cp -a "${PACKAGE_SRC}/." "${STAGING_DIR}/"

# Mise à jour dynamique de la version dans DEBIAN/control, sw.js (invalidation auto du cache PWA) et PHP
sed -i "s/^Version: .*/Version: ${PKG_VERSION}/" "${STAGING_DIR}/DEBIAN/control"
if [[ -f "${STAGING_DIR}/usr/share/vanill-ia-os/sw.js" ]]; then
    sed -i -E "s/^const CACHE_VERSION = '[^']+';/const CACHE_VERSION = '${PKG_NAME}-v${PKG_VERSION}';/" "${STAGING_DIR}/usr/share/vanill-ia-os/sw.js"
fi
if [[ -f "${STAGING_DIR}/usr/share/vanill-ia-os/api/bootstrap.php" ]]; then
    sed -i -E "s/^const VANILLIA_VERSION = '[^']+';/const VANILLIA_VERSION = '${PKG_VERSION}';/" "${STAGING_DIR}/usr/share/vanill-ia-os/api/bootstrap.php"
fi
if [[ -f "${STAGING_DIR}/usr/local/bin/vanill-ia-agent" ]]; then
    sed -i -E "s/public const VERSION = '[^']+';/public const VERSION = '${PKG_VERSION}';/" "${STAGING_DIR}/usr/local/bin/vanill-ia-agent"
fi

# Création des dossiers runtime / données garantis dans le paquet
mkdir -p \
    "${STAGING_DIR}/etc/caddy/conf.d" \
    "${STAGING_DIR}/etc/fail2ban/filter.d" \
    "${STAGING_DIR}/etc/fail2ban/jail.d" \
    "${STAGING_DIR}/etc/systemd/system" \
    "${STAGING_DIR}/usr/local/bin" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/api" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/apps" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/assets/css" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/assets/js/core" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/assets/js/apps" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/assets/img/pwa" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/assets/img/wallpapers" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/assets/img/icons" \
    "${STAGING_DIR}/usr/share/vanill-ia-os/config" \
    "${STAGING_DIR}/var/lib/vanill-ia-os/data" \
    "${STAGING_DIR}/var/lib/vanill-ia-os/apps" \
    "${STAGING_DIR}/var/lib/vanill-ia-os/notes" \
    "${STAGING_DIR}/var/lib/vanill-ia-os/stacks" \
    "${STAGING_DIR}/var/lib/vanill-ia-os/tmp"

# Suppression d'éventuels fichiers parasites (.gitkeep, .DS_Store, Thumbs.db)
find "${STAGING_DIR}" -type f \( -name ".gitkeep" -o -name ".DS_Store" -o -name "Thumbs.db" \) -delete

# Normalisation stricte des fins de ligne LF (sécurité si édité depuis Windows)
find "${STAGING_DIR}/DEBIAN" "${STAGING_DIR}/usr/local/bin" "${STAGING_DIR}/etc" \
    -type f -exec sed -i 's/\r$//' {} +
find "${STAGING_DIR}/usr/share/vanill-ia-os" \
    -type f \( -name "*.php" -o -name "*.sh" -o -name "*.sql" -o -name "*.js" -o -name "*.css" -o -name "*.json" -o -name "*.html" \) \
    -exec sed -i 's/\r$//' {} +

# Permissions strictes exigées par dpkg-deb (0755 sur dossiers et scripts maintainer)
find "${STAGING_DIR}" -type d -exec chmod 0755 {} +
find "${STAGING_DIR}" -type f -exec chmod 0644 {} +

chmod 0755 "${STAGING_DIR}/DEBIAN/postinst"
if [[ -f "${STAGING_DIR}/DEBIAN/prerm" ]]; then
    chmod 0755 "${STAGING_DIR}/DEBIAN/prerm"
fi
chmod 0755 "${STAGING_DIR}/usr/local/bin/vanill-ia-agent"
for helper_bin in vanill-ia-cron-run vanill-ia-os vanill-ia-browser-ctl vanill-ia-docker-install; do
    if [[ -f "${STAGING_DIR}/usr/local/bin/${helper_bin}" ]]; then
        chmod 0755 "${STAGING_DIR}/usr/local/bin/${helper_bin}"
    fi
done
if [[ -f "${STAGING_DIR}/usr/share/vanill-ia-os/lib/env-detect.sh" ]]; then
    chmod 0755 "${STAGING_DIR}/usr/share/vanill-ia-os/lib/env-detect.sh"
fi
chmod 0750 "${STAGING_DIR}/var/lib/vanill-ia-os/data"
chmod 0750 "${STAGING_DIR}/var/lib/vanill-ia-os/tmp"

# Vérification syntaxique PHP si php-cli est disponible localement
if command -v php >/dev/null 2>&1; then
    echo "[INFO] Vérification syntaxique PHP (lint)..."
    while IFS= read -r -d '' php_file; do
        php -l "${php_file}" >/dev/null
    done < <(find "${STAGING_DIR}" -type f \( -name "*.php" -o -path "*/usr/local/bin/vanill-ia-*" \) -print0)
    echo "[OK] Syntaxe PHP validée sans erreur."
fi

DEB_OUTPUT="${DIST_DIR}/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH}.deb"

echo "[INFO] Empaquetage via dpkg-deb --build --root-owner-group..."
dpkg-deb --build --root-owner-group "${STAGING_DIR}" "${DEB_OUTPUT}"

# Calcul du hash SHA256
if command -v sha256sum >/dev/null 2>&1; then
    (cd "${DIST_DIR}" && sha256sum "$(basename "${DEB_OUTPUT}")" > "$(basename "${DEB_OUTPUT}").sha256")
fi

echo "=========================================================="
echo "[SUCCÈS] Paquet généré : ${DEB_OUTPUT}"
dpkg-deb --info "${DEB_OUTPUT}"
echo "=========================================================="
