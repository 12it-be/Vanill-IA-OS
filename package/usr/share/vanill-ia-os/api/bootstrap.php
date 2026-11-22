<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Web API Security Bootstrap
 * - SQLite3 WAL Connection & Auto-Init
 * - At-Rest Secret Encryption (Sodium XSalsa20-Poly1305 / AES-256-GCM fallback)
 * - Hardened Sessions (HttpOnly, Secure, SameSite=Strict, Inactivity Auto-Lock)
 * - CSRF Protection (X-CSRF-Token)
 * - SQLite Anti-Bruteforce + /var/log/vanill-ia-auth.log Fail2ban Integration
 * ==============================================================================
 */

require_once __DIR__ . '/AgentClient.php';
require_once __DIR__ . '/Totp.php';

const VANILLIA_VERSION = '1.7.1';
const VANILLIA_DATA_DIR = '/var/lib/vanill-ia-os/data';
const VANILLIA_APPS_DIR = '/var/lib/vanill-ia-os/apps';
const VANILLIA_SESSIONS_DIR = '/var/lib/vanill-ia-os/sessions';
const VANILLIA_AUTH_LOG = '/var/log/vanill-ia-auth.log';

/**
 * Résout le dossier des plugins dynamiques (/var/lib/vanill-ia-os/apps).
 */
function vanillia_plugins_dir(): string
{
    if (is_dir(VANILLIA_APPS_DIR)) {
        return VANILLIA_APPS_DIR;
    }
    $fallback = dirname(__DIR__) . '/.dev-data/apps';
    if (!is_dir($fallback)) {
        @mkdir($fallback, 0755, true);
    }
    return $fallback;
}

/**
 * Résout le dossier de données (production Debian ou fallback dev local).
 */
function vanillia_data_dir(): string
{
    if (is_dir(VANILLIA_DATA_DIR) && is_writable(VANILLIA_DATA_DIR)) {
        return VANILLIA_DATA_DIR;
    }
    $fallback = dirname(__DIR__) . '/.dev-data';
    if (!is_dir($fallback)) {
        @mkdir($fallback, 0750, true);
    }
    return $fallback;
}

/**
 * Connexion singleton SQLite3 en mode WAL.
 */
function vanillia_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dataDir = vanillia_data_dir();
    $dbFile = $dataDir . '/vanill-ia.db';
    $needsInit = !is_file($dbFile) || filesize($dbFile) === 0;

    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT            => 5,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL;');
    $pdo->exec('PRAGMA foreign_keys = ON;');
    $pdo->exec('PRAGMA busy_timeout = 5000;');

    if ($needsInit) {
        $schemaFile = dirname(__DIR__) . '/config/schema.sql';
        if (is_readable($schemaFile)) {
            $pdo->exec((string) file_get_contents($schemaFile));
        }
    } else {
        vanillia_migrate_db($pdo);
    }

    return $pdo;
}

/**
 * Migrations automatiques rétrocompatibles sans perte de données SQLite.
 */
function vanillia_migrate_db(PDO $pdo): void
{
    static $migrated = false;
    if ($migrated) {
        return;
    }
    $migrated = true;

    try {
        $cols = $pdo->query('PRAGMA table_info(users)')->fetchAll();
        $colNames = array_column($cols, 'name');
        if ($cols !== [] && !in_array('language', $colNames, true)) {
            $pdo->exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
        }

        // Idempotent migration of `notifications` columns (`user_id`, `action_url`, `action_label`)
        $notifCols = $pdo->query('PRAGMA table_info(notifications)')->fetchAll();
        $notifColNames = array_column($notifCols, 'name');
        if ($notifCols !== []) {
            if (!in_array('user_id', $notifColNames, true)) {
                $pdo->exec('ALTER TABLE notifications ADD COLUMN user_id INTEGER DEFAULT NULL');
            }
            if (!in_array('action_url', $notifColNames, true)) {
                $pdo->exec('ALTER TABLE notifications ADD COLUMN action_url TEXT DEFAULT NULL');
            }
            if (!in_array('action_label', $notifColNames, true)) {
                $pdo->exec('ALTER TABLE notifications ADD COLUMN action_label TEXT DEFAULT NULL');
            }
        }

        // Normalize legacy shortcut & wallpaper identifiers
        $pdo->exec("UPDATE desktop_shortcuts SET title = 'Files' WHERE app_id = 'file-station' AND title = 'File Station'");
        $pdo->exec("UPDATE users SET wallpaper = 'twilight' WHERE wallpaper LIKE '%twilight'");

        // Create file_shares table if absent on upgraded databases
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS file_shares (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                token          TEXT    NOT NULL UNIQUE,
                file_path      TEXT    NOT NULL,
                file_name      TEXT    NOT NULL,
                file_size      INTEGER NOT NULL DEFAULT 0,
                password_hash  TEXT    DEFAULT NULL,
                expires_at     INTEGER DEFAULT NULL,
                max_downloads  INTEGER DEFAULT NULL,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at     INTEGER NOT NULL
            )"
        );
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_file_shares_token ON file_shares(token)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_file_shares_creator ON file_shares(created_by, created_at DESC)');

        // Upgrade desktop_shortcuts schema if `url` column or expanded `open_mode` constraints are missing
        $scCols = $pdo->query('PRAGMA table_info(desktop_shortcuts)')->fetchAll();
        $scColNames = array_column($scCols, 'name');
        if ($scCols !== [] && !in_array('url', $scColNames, true)) {
            $pdo->beginTransaction();
            try {
                $pdo->exec(
                    "CREATE TABLE desktop_shortcuts_new (
                        id             INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id        INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE CASCADE,
                        app_id         TEXT    NOT NULL,
                        app_type       TEXT    NOT NULL DEFAULT 'system' CHECK (app_type IN ('system', 'docker', 'webapp', 'shortcut')),
                        title          TEXT    NOT NULL,
                        subtitle       TEXT    NOT NULL DEFAULT '',
                        icon           TEXT    NOT NULL DEFAULT 'globe',
                        icon_url       TEXT    DEFAULT NULL,
                        accent_color   TEXT    NOT NULL DEFAULT '#FF6D5A',
                        url            TEXT    DEFAULT NULL,
                        target_url     TEXT    DEFAULT NULL,
                        container_name TEXT    DEFAULT NULL,
                        open_mode      TEXT    NOT NULL DEFAULT 'external' CHECK (open_mode IN ('window', 'iframe', 'tab', 'external', 'remote_browser')),
                        pinned_desktop INTEGER NOT NULL DEFAULT 1 CHECK (pinned_desktop IN (0, 1)),
                        pinned_dock    INTEGER NOT NULL DEFAULT 0 CHECK (pinned_dock IN (0, 1)),
                        sort_order     INTEGER NOT NULL DEFAULT 100,
                        created_at     INTEGER NOT NULL DEFAULT ( CAST(strftime('%s', 'now') AS INTEGER) )
                    )"
                );
                $pdo->exec(
                    "INSERT INTO desktop_shortcuts_new
                        (id, user_id, app_id, app_type, title, subtitle, icon, accent_color, url, target_url, container_name, open_mode, pinned_desktop, pinned_dock, sort_order)
                     SELECT
                        id, user_id, app_id, app_type, title, subtitle, icon, accent_color, target_url, target_url, container_name, open_mode, pinned_desktop, pinned_dock, sort_order
                     FROM desktop_shortcuts"
                );
                $pdo->exec('DROP TABLE desktop_shortcuts');
                $pdo->exec('ALTER TABLE desktop_shortcuts_new RENAME TO desktop_shortcuts');
                $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shortcuts_unique_app ON desktop_shortcuts(COALESCE(user_id, 0), app_id)');
                $pdo->commit();
            } catch (Throwable) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
            }
        }

        // Ensure built-in Mount & Web Browser shortcuts exist on upgraded databases
        $pdo->exec(
            "INSERT OR IGNORE INTO desktop_shortcuts
                (user_id, app_id, app_type, title, subtitle, icon, accent_color, open_mode, pinned_desktop, pinned_dock, sort_order)
             VALUES
                (NULL, 'mount-manager', 'system', 'Mount', 'SMB/CIFS Network Shares', 'harddrive', '#F97316', 'window', 1, 0, 35),
                (NULL, 'web-browser', 'system', 'Web Browser', 'Isolated Remote Chromium', 'globe', '#3B82F6', 'window', 1, 1, 45)"
        );
    } catch (Throwable) {
        // Tolérance en lecture seule éventuelle
    }
}

/**
 * Dynamically scans `/var/lib/vanill-ia-os/apps/[app]/manifest.json` without rebuilding the .deb.
 *
 * @return list<array<string, mixed>>
 */
function vanillia_discover_plugins(): array
{
    $appsRoot = vanillia_plugins_dir();
    if (!is_dir($appsRoot) || !is_readable($appsRoot)) {
        return [];
    }

    $manifests = glob($appsRoot . '/*/manifest.json') ?: [];
    $plugins = [];

    foreach ($manifests as $manifestFile) {
        if (!is_readable($manifestFile)) {
            continue;
        }
        $raw = json_decode((string) file_get_contents($manifestFile), true);
        if (!is_array($raw)) {
            continue;
        }

        $folderName = basename(dirname($manifestFile));
        $pluginId = isset($raw['id']) && is_string($raw['id']) && preg_match('/^[a-zA-Z0-9_-]{2,48}$/', $raw['id']) === 1
            ? $raw['id']
            : $folderName;

        if (preg_match('/^[a-zA-Z0-9_-]{2,48}$/', $folderName) !== 1) {
            continue;
        }

        $launchMode = (($raw['launchMode'] ?? 'window') === 'external') ? 'external' : 'window';
        $entry = isset($raw['entry']) && is_string($raw['entry']) ? ltrim(trim($raw['entry']), '/') : '';
        $externalUrl = isset($raw['url']) && is_string($raw['url']) ? trim($raw['url']) : '';

        if ($launchMode === 'external') {
            $targetUrl = $externalUrl !== '' ? $externalUrl : $entry;
            $openMode = 'tab';
        } else {
            $targetUrl = $externalUrl !== ''
                ? $externalUrl
                : '/plugins.php/' . rawurlencode($folderName) . '/' . ($entry !== '' ? $entry : 'index.html');
            $openMode = 'iframe';
        }

        $iconSpec = isset($raw['icon']) && is_string($raw['icon']) ? trim($raw['icon']) : 'box';
        $iconUrl = null;
        if (str_ends_with(strtolower($iconSpec), '.svg') || str_ends_with(strtolower($iconSpec), '.png') || str_contains($iconSpec, '/')) {
            if (str_starts_with($iconSpec, 'http://') || str_starts_with($iconSpec, 'https://') || str_starts_with($iconSpec, '/')) {
                $iconUrl = $iconSpec;
            } else {
                $iconUrl = '/plugins.php/' . rawurlencode($folderName) . '/' . ltrim($iconSpec, './');
            }
        }

        $nameField = $raw['name'] ?? $pluginId;
        $descField = $raw['description'] ?? '';
        $defaultTitle = is_array($nameField)
            ? (string) ($nameField['en'] ?? reset($nameField) ?: $pluginId)
            : (string) $nameField;
        $defaultSub = is_array($descField)
            ? (string) ($descField['en'] ?? reset($descField) ?: '')
            : (string) $descField;

        $accent = isset($raw['accentColor']) && is_string($raw['accentColor']) && preg_match('/^#[0-9a-fA-F]{6}$/', $raw['accentColor']) === 1
            ? $raw['accentColor']
            : '#6366F1';

        $plugins[] = [
            'id'             => 10000 + count($plugins),
            'app_id'         => 'plugin:' . $pluginId,
            'plugin_id'      => $pluginId,
            'plugin_folder'  => $folderName,
            'app_type'       => 'plugin',
            'title'          => $defaultTitle,
            'name_i18n'      => is_array($nameField) ? $nameField : null,
            'subtitle'       => $defaultSub,
            'desc_i18n'      => is_array($descField) ? $descField : null,
            'icon'           => $iconUrl !== null ? 'box' : $iconSpec,
            'icon_url'       => $iconUrl,
            'accent_color'   => $accent,
            'target_url'     => $targetUrl,
            'launch_mode'    => $launchMode,
            'open_mode'      => $openMode,
            'defaultWidth'   => isset($raw['width']) ? (int) $raw['width'] : 980,
            'defaultHeight'  => isset($raw['height']) ? (int) $raw['height'] : 640,
            'pinned_desktop' => ($raw['showOnDesktop'] ?? true) ? true : false,
            'pinned_dock'    => ($raw['pinToDock'] ?? false) ? true : false,
            'sort_order'     => isset($raw['order']) ? (int) $raw['order'] : 300,
        ];
    }

    return $plugins;
}

/**
 * Clé binaire 32 octets pour le chiffrement des secrets sensibles (TOTP, clés API).
 */
function vanillia_master_key(): string
{
    $keyFile = vanillia_data_dir() . '/.secret.key';
    if (is_readable($keyFile)) {
        $hex = trim((string) file_get_contents($keyFile));
        if (strlen($hex) === 64 && ctype_xdigit($hex)) {
            return (string) hex2bin($hex);
        }
    }

    $raw = random_bytes(32);
    @file_put_contents($keyFile, bin2hex($raw));
    @chmod($keyFile, 0600);
    return $raw;
}

/**
 * Chiffre une chaîne sensible avant stockage en base SQLite.
 */
function vanillia_encrypt(string $plaintext): string
{
    if ($plaintext === '') {
        return '';
    }
    $key = vanillia_master_key();

    if (function_exists('sodium_crypto_secretbox')) {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $cipher = sodium_crypto_secretbox($plaintext, $nonce, $key);
        return 'v1:sodium:' . base64_encode($nonce . $cipher);
    }

    $iv = random_bytes(12);
    $tag = '';
    $cipher = openssl_encrypt($plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    return 'v1:gcm:' . base64_encode($iv . $tag . (string) $cipher);
}

/**
 * Déchiffre une chaîne issue de SQLite.
 */
function vanillia_decrypt(?string $stored): string
{
    if ($stored === null || $stored === '') {
        return '';
    }
    $key = vanillia_master_key();

    if (str_starts_with($stored, 'v1:sodium:')) {
        $raw = base64_decode(substr($stored, 10), true);
        if ($raw === false || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
            return '';
        }
        $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $cipher = substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $plain = sodium_crypto_secretbox_open($cipher, $nonce, $key);
        return $plain === false ? '' : $plain;
    }

    if (str_starts_with($stored, 'v1:gcm:')) {
        $raw = base64_decode(substr($stored, 7), true);
        if ($raw === false || strlen($raw) <= 28) {
            return '';
        }
        $iv = substr($raw, 0, 12);
        $tag = substr($raw, 12, 16);
        $cipher = substr($raw, 28);
        $plain = openssl_decrypt($cipher, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        return $plain === false ? '' : $plain;
    }

    return $stored;
}

/**
 * Détecte si la requête courante transite en HTTPS (direct ou via Caddy).
 */
function vanillia_is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (isset($_SERVER['SERVER_PORT']) && (int) $_SERVER['SERVER_PORT'] === 443) {
        return true;
    }
    if (!empty($_SERVER['REQUEST_SCHEME']) && strtolower((string) $_SERVER['REQUEST_SCHEME']) === 'https') {
        return true;
    }
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
        $firstProto = strtolower(trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_PROTO'])[0]));
        if ($firstProto === 'https') {
            return true;
        }
    }
    if (!empty($_SERVER['HTTP_X_FORWARDED_SSL']) && strtolower((string) $_SERVER['HTTP_X_FORWARDED_SSL']) === 'on') {
        return true;
    }
    if (!empty($_SERVER['HTTP_FORWARDED']) && stripos((string) $_SERVER['HTTP_FORWARDED'], 'proto=https') !== false) {
        return true;
    }
    if (!empty($_SERVER['HTTP_CF_VISITOR']) && stripos((string) $_SERVER['HTTP_CF_VISITOR'], '"https"') !== false) {
        return true;
    }
    return false;
}

/**
 * Retourne l'adresse IP réelle du client (en ne faisant confiance aux headers proxy que depuis loopback).
 */
function vanillia_client_ip(): string
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '127.0.0.1');
    if (in_array($remote, ['127.0.0.1', '::1'], true) && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR']);
        $candidate = trim($parts[0]);
        if (filter_var($candidate, FILTER_VALIDATE_IP) !== false) {
            return $candidate;
        }
    }
    return filter_var($remote, FILTER_VALIDATE_IP) !== false ? $remote : '127.0.0.1';
}

/**
 * Vérifie si une IP appartient au réseau local privé (RFC1918 / Loopback) ou au CGNAT Tailscale (100.64.0.0/10).
 */
function vanillia_is_lan_or_tailscale_ip(string $ip): bool
{
    if ($ip === '127.0.0.1' || $ip === '::1') {
        return true;
    }

    // IPv4 privée + Tailscale 100.64.0.0/10
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        $long = ip2long($ip);
        if ($long === false) {
            return false;
        }
        $ranges = [
            ['127.0.0.0', '255.0.0.0'],
            ['10.0.0.0', '255.0.0.0'],
            ['172.16.0.0', '255.240.0.0'],
            ['192.168.0.0', '255.255.0.0'],
            ['100.64.0.0', '255.192.0.0'], // Tailscale WireGuard CGNAT
        ];
        foreach ($ranges as [$net, $mask]) {
            if (($long & ip2long($mask)) === ip2long($net)) {
                return true;
            }
        }
        return false;
    }

    // IPv6 Unique Local (fc00::/7) ou Tailscale (fd7a:115c:a1e0::/48)
    $lower = strtolower($ip);
    return str_starts_with($lower, 'fc') || str_starts_with($lower, 'fd') || str_starts_with($lower, 'fe80:');
}

/**
 * Starts the hardened session and enforces automatic inactivity screen lock.
 */
function vanillia_start_session(bool $touchActivity = true): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    if (is_dir(VANILLIA_SESSIONS_DIR) && is_writable(VANILLIA_SESSIONS_DIR)) {
        session_save_path(VANILLIA_SESSIONS_DIR);
    }

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.cookie_httponly', '1');

    session_name('VANILLIA_SESSID');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'domain'   => '',
        'secure'   => vanillia_is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);

    session_start();

    if (empty($_SESSION['csrf_token']) || !is_string($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }

    // Automatic session lock after configured inactivity timeout
    if (!empty($_SESSION['user_id']) && empty($_SESSION['locked'])) {
        $lockMinutes = (int) ($_SESSION['session_lock_minutes'] ?? 15);
        $lastActive = (int) ($_SESSION['last_activity_at'] ?? time());

        if ($lockMinutes > 0 && (time() - $lastActive) > ($lockMinutes * 60)) {
            $_SESSION['locked'] = true;
        } elseif ($touchActivity) {
            $_SESSION['last_activity_at'] = time();
        }
    }
}

/**
 * Retourne le jeton CSRF courant.
 */
function vanillia_csrf_token(): string
{
    vanillia_start_session(false);
    return (string) $_SESSION['csrf_token'];
}

/**
 * Lit le corps JSON (ou POST classique) d'une requête API.
 *
 * @return array<string, mixed>
 */
function vanillia_read_body(): array
{
    static $cached = null;
    if (is_array($cached)) {
        return $cached;
    }

    $raw = (string) file_get_contents('php://input');
    if ($raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $cached = $decoded;
            return $cached;
        }
    }

    $cached = $_POST;
    return $cached;
}

/**
 * Vérifie strictement le token CSRF sur toute méthode modifiante.
 */
function vanillia_verify_csrf(): void
{
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
        return;
    }

    vanillia_start_session(false);
    $expected = (string) ($_SESSION['csrf_token'] ?? '');
    $provided = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');

    if ($provided === '') {
        $body = vanillia_read_body();
        $provided = isset($body['_csrf']) && is_string($body['_csrf']) ? $body['_csrf'] : '';
    }

    if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
        vanillia_json_error('CSRF_INVALID', 'Jeton de sécurité CSRF manquant ou expiré. Rechargez la page.', 403);
    }
}

/**
 * Envoie une réponse JSON standardisée et termine l'exécution.
 *
 * @param array<string, mixed> $data
 */
function vanillia_json_success(array $data = [], int $httpCode = 200): never
{
    http_response_code($httpCode);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');

    echo json_encode([
        'ok'   => true,
        'data' => $data,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Envoie une erreur JSON standardisée et termine l'exécution.
 *
 * @param array<string, mixed> $extra
 */
function vanillia_json_error(string $code, string $message, int $httpCode = 400, array $extra = []): never
{
    http_response_code($httpCode);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');

    echo json_encode([
        'ok'    => false,
        'error' => array_merge([
            'code'    => $code,
            'message' => $message,
        ], $extra),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Exige une session authentifiée et déverrouillée (retourne le profil utilisateur complet).
 *
 * @return array<string, mixed>
 */
function vanillia_require_auth(bool $allowLocked = false, bool $touchActivity = true): array
{
    vanillia_start_session($touchActivity);

    $userId = (int) ($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) {
        vanillia_json_error('UNAUTHENTICATED', 'Authentification requise.', 401);
    }

    if (!$allowLocked && !empty($_SESSION['locked'])) {
        vanillia_json_error('SESSION_LOCKED', 'La session est verrouillée suite à une période d\'inactivité.', 423);
    }

    $pdo = vanillia_db();
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $userId]);
    $user = $stmt->fetch();

    if ($user === false) {
        session_unset();
        session_destroy();
        vanillia_json_error('USER_NOT_FOUND', 'Compte utilisateur introuvable.', 401);
    }

    vanillia_verify_csrf();
    return $user;
}

/**
 * Exige le rôle administrateur.
 *
 * @return array<string, mixed>
 */
function vanillia_require_admin(): array
{
    $user = vanillia_require_auth();
    if (($user['role'] ?? '') !== 'admin') {
        vanillia_json_error('FORBIDDEN', 'Droits administrateur requis pour cette action.', 403);
    }
    return $user;
}

/**
 * Lit un paramètre global dans la table `settings`.
 */
function vanillia_get_setting(string $key, string $default = ''): string
{
    $stmt = vanillia_db()->prepare('SELECT value FROM settings WHERE key = :k LIMIT 1');
    $stmt->execute([':k' => $key]);
    $val = $stmt->fetchColumn();
    return $val !== false ? (string) $val : $default;
}

/**
 * Enregistre un paramètre global dans la table `settings`.
 */
function vanillia_set_setting(string $key, string $value, string $category = 'general'): void
{
    $stmt = vanillia_db()->prepare(
        'INSERT INTO settings (key, value, category, updated_at)
         VALUES (:k, :v, :c, :u)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    $stmt->execute([
        ':k' => $key,
        ':v' => $value,
        ':c' => $category,
        ':u' => gmdate('Y-m-d H:i:s'),
    ]);
}

/**
 * Vérifie si l'IP cliente est temporairement bloquée par l'anti-bruteforce SQLite.
 */
function vanillia_check_rate_limit(string $ip): void
{
    $pdo = vanillia_db();
    $now = time();

    // Nettoyage léger des entrées expirées depuis plus de 24h
    $pdo->prepare('DELETE FROM auth_attempts WHERE last_fail_at < :old')->execute([':old' => $now - 86400]);

    $stmt = $pdo->prepare('SELECT fail_count, locked_until FROM auth_attempts WHERE ip_address = :ip LIMIT 1');
    $stmt->execute([':ip' => $ip]);
    $row = $stmt->fetch();

    if ($row !== false && (int) $row['locked_until'] > $now) {
        $remainingSec = (int) $row['locked_until'] - $now;
        $minutes = (int) ceil($remainingSec / 60);
        vanillia_json_error(
            'RATE_LIMITED',
            sprintf('Trop de tentatives échouées. Réessayez dans %d min (%ds).', $minutes, $remainingSec),
            429,
            ['retry_after_sec' => $remainingSec]
        );
    }
}

/**
 * Journalise un échec d'authentification dans SQLite + dans /var/log/vanill-ia-auth.log (lu par Fail2ban).
 */
function vanillia_record_auth_failure(string $ip, string $username, string $reason): void
{
    $pdo = vanillia_db();
    $now = time();
    $maxAttempts = max(3, (int) vanillia_get_setting('security.max_login_attempts', '5'));
    $lockoutMin = max(1, (int) vanillia_get_setting('security.lockout_minutes', '15'));

    $stmt = $pdo->prepare('SELECT * FROM auth_attempts WHERE ip_address = :ip LIMIT 1');
    $stmt->execute([':ip' => $ip]);
    $existing = $stmt->fetch();

    $windowResetSec = $lockoutMin * 60;
    if ($existing === false || ($now - (int) $existing['last_fail_at']) > $windowResetSec) {
        $failCount = 1;
        $firstFail = $now;
    } else {
        $failCount = ((int) $existing['fail_count']) + 1;
        $firstFail = (int) $existing['first_fail_at'];
    }

    $lockedUntil = $failCount >= $maxAttempts ? ($now + ($lockoutMin * 60)) : 0;

    $upsert = $pdo->prepare(
        'INSERT INTO auth_attempts (ip_address, fail_count, first_fail_at, last_fail_at, locked_until, last_username)
         VALUES (:ip, :fc, :ff, :lf, :lu, :un)
         ON CONFLICT(ip_address) DO UPDATE SET
            fail_count = excluded.fail_count,
            first_fail_at = excluded.first_fail_at,
            last_fail_at = excluded.last_fail_at,
            locked_until = excluded.locked_until,
            last_username = excluded.last_username'
    );
    $upsert->execute([
        ':ip' => $ip,
        ':fc' => $failCount,
        ':ff' => $firstFail,
        ':lf' => $now,
        ':lu' => $lockedUntil,
        ':un' => substr($username, 0, 64),
    ]);

    // Écriture normalisée pour le filtre Fail2ban (/etc/fail2ban/filter.d/vanill-ia-os.conf)
    $safeUser = preg_replace('/[^a-zA-Z0-9_.@-]/', '_', $username) ?: 'unknown';
    $safeReason = preg_replace('/[^a-zA-Z0-9_.-]/', '_', $reason) ?: 'failed';
    $logLine = sprintf("%s VANILL-IA-AUTH FAIL ip=%s user=%s reason=%s\n", gmdate('Y-m-d\TH:i:s\Z'), $ip, $safeUser, $safeReason);

    if (is_writable(VANILLIA_AUTH_LOG) || (!file_exists(VANILLIA_AUTH_LOG) && is_writable(dirname(VANILLIA_AUTH_LOG)))) {
        @file_put_contents(VANILLIA_AUTH_LOG, $logLine, FILE_APPEND | LOCK_EX);
    } else {
        @file_put_contents(vanillia_data_dir() . '/vanill-ia-auth.log', $logLine, FILE_APPEND | LOCK_EX);
    }

    vanillia_audit_log(null, $username ?: 'anonymous', 'auth.failed', $reason, ['fail_count' => $failCount]);
}

/**
 * Réinitialise le compteur d'échecs d'une IP après authentification réussie.
 */
function vanillia_clear_auth_failures(string $ip): void
{
    vanillia_db()->prepare('DELETE FROM auth_attempts WHERE ip_address = :ip')->execute([':ip' => $ip]);
}

/**
 * Records a persistent notification in the Bell Notification Center (`notifications` table).
 *
 * @param array<string, mixed>|null $actionPayload
 */
function push_system_notification(
    PDO $db,
    int $userId,
    string $level,
    string $title,
    string $message,
    ?string $actionUrl = null,
    ?string $actionLabel = null,
    string $source = 'system',
    ?array $actionPayload = null
): int {
    try {
        $validLevel = in_array($level, ['info', 'success', 'warning', 'error'], true) ? $level : 'info';
        $cleanTitle = mb_substr(trim($title), 0, 140) ?: 'Notification';
        $cleanMsg = mb_substr(trim($message), 0, 500);
        $cleanUrl = ($actionUrl !== null && trim($actionUrl) !== '') ? trim($actionUrl) : null;
        $cleanLabel = ($actionLabel !== null && trim($actionLabel) !== '') ? mb_substr(trim($actionLabel), 0, 48) : null;
        $payloadJson = $actionPayload !== null
            ? (json_encode($actionPayload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: null)
            : null;

        $stmt = $db->prepare(
            'INSERT INTO notifications
                (user_id, level, source, title, message, action_url, action_label, action_payload_json, is_read, created_at)
             VALUES
                (:uid, :lvl, :src, :ttl, :msg, :url, :lbl, :pld, 0, :ts)'
        );
        $stmt->execute([
            ':uid' => $userId > 0 ? $userId : null,
            ':lvl' => $validLevel,
            ':src' => substr($source, 0, 40) ?: 'system',
            ':ttl' => $cleanTitle,
            ':msg' => $cleanMsg,
            ':url' => $cleanUrl,
            ':lbl' => $cleanLabel,
            ':pld' => $payloadJson,
            ':ts'  => gmdate('Y-m-d H:i:s'),
        ]);

        $insertedId = (int) $db->lastInsertId();

        // Keep at most the 200 most recent notifications
        $db->exec(
            'DELETE FROM notifications
             WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 200)'
        );

        return $insertedId;
    } catch (Throwable) {
        return 0;
    }
}

/**
 * Ajoute une trace dans le journal d'audit SQLite.
 *
 * @param array<string, mixed> $details
 */
function vanillia_audit_log(?int $userId, string $username, string $action, ?string $target = null, array $details = []): void
{
    try {
        $stmt = vanillia_db()->prepare(
            'INSERT INTO audit_logs (user_id, username, ip_address, action, target, details_json, created_at)
             VALUES (:uid, :un, :ip, :act, :tgt, :det, :ts)'
        );
        $stmt->execute([
            ':uid' => $userId,
            ':un'  => $username,
            ':ip'  => vanillia_client_ip(),
            ':act' => $action,
            ':tgt' => $target,
            ':det' => json_encode($details, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}',
            ':ts'  => gmdate('Y-m-d H:i:s'),
        ]);
    } catch (Throwable) {
        // Ne jamais bloquer une requête métier sur une erreur de log secondaire
    }
}
