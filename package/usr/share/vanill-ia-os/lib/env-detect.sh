#!/usr/bin/env bash
# ==============================================================================
# Vanill-IA OS — Shared Multi-Distro Runtime Detection Helpers
# Supports Debian 12/13, Ubuntu 22.04/24.04+, and Raspberry Pi OS
# ==============================================================================

vanillia_detect_php_fpm_service() {
    local svc=""
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
        svc="$(systemctl list-units --type=service --state=running 'php*fpm*.service' --no-legend --plain 2>/dev/null | awk 'NR==1 {sub(/\.service$/, "", $1); print $1}')"
        if [[ -n "${svc}" ]]; then
            echo "${svc}"
            return 0
        fi
    fi

    local unit_file
    unit_file="$(ls -1 /lib/systemd/system/php*-fpm.service /usr/lib/systemd/system/php*-fpm.service /lib/systemd/system/php-fpm.service /usr/lib/systemd/system/php-fpm.service 2>/dev/null | sort -Vr | head -n 1 || true)"
    if [[ -n "${unit_file}" ]]; then
        basename "${unit_file}" .service
        return 0
    fi

    if command -v php >/dev/null 2>&1; then
        local ver
        ver="$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;' 2>/dev/null || true)"
        if [[ -n "${ver}" ]]; then
            echo "php${ver}-fpm"
            return 0
        fi
    fi

    echo "php-fpm"
}

vanillia_detect_php_fpm_socket() {
    local sock=""
    while IFS= read -r candidate; do
        if [[ -S "${candidate}" ]]; then
            sock="${candidate}"
            break
        fi
    done < <(ls -1 /run/php/php*-fpm.sock /run/php/php-fpm.sock /run/php-fpm/www.sock 2>/dev/null | sort -Vr || true)

    if [[ -n "${sock}" ]]; then
        echo "${sock}"
        return 0
    fi

    local svc
    svc="$(vanillia_detect_php_fpm_service)"
    if [[ "${svc}" =~ ^php([0-9]+\.[0-9]+)-fpm$ ]]; then
        echo "/run/php/${svc}.sock"
        return 0
    fi

    if command -v php >/dev/null 2>&1; then
        local ver
        ver="$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;' 2>/dev/null || true)"
        if [[ -n "${ver}" ]]; then
            echo "/run/php/php${ver}-fpm.sock"
            return 0
        fi
    fi

    echo "/run/php/php-fpm.sock"
}

vanillia_detect_chromium_bin() {
    local candidate
    for candidate in \
        "$(command -v chromium 2>/dev/null || true)" \
        "$(command -v chromium-browser 2>/dev/null || true)" \
        "/usr/bin/chromium" \
        "/usr/bin/chromium-browser" \
        "/snap/bin/chromium"; do
        if [[ -n "${candidate}" && -x "${candidate}" ]]; then
            echo "${candidate}"
            return 0
        fi
    done
    return 1
}

vanillia_detect_novnc_webroot() {
    local dir
    for dir in "/usr/share/novnc" "/usr/share/novnc/www"; do
        if [[ -d "${dir}" && -f "${dir}/vnc.html" ]]; then
            echo "${dir}"
            return 0
        fi
    done
    if [[ -d "/usr/share/novnc" ]]; then
        echo "/usr/share/novnc"
        return 0
    fi
    return 1
}
