<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — User Web Shortcuts & External Links API (/api/shortcuts.php)
 * Supports 3 launch modes:
 *   - 'external'       : Opens URL in a new client browser tab (_blank)
 *   - 'window'         : Opens URL inside an internal sandboxed WebOS window
 *   - 'remote_browser' : Launches isolated VPS Chromium directly on the URL
 * Strict URL validation: `http://` or `https://` exclusively.
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$user = vanillia_require_auth();
$pdo = vanillia_db();

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$action = trim((string) ($_GET['action'] ?? ''));

if ($action === '') {
    $action = match ($method) {
        'POST'   => 'save',
        'DELETE' => 'delete',
        default  => 'list',
    };
}

/**
 * Strictly validates that an external shortcut URL uses http:// or https://.
 */
function validate_http_shortcut_url(string $url): string
{
    $url = trim($url);
    if ($url === '' || strlen($url) > 2048 || preg_match('/[\r\n\0]/', $url) === 1) {
        vanillia_json_error('INVALID_URL', 'Please enter a valid http:// or https:// URL.');
    }

    $parts = parse_url($url);
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    $host = (string) ($parts['host'] ?? '');

    if (!in_array($scheme, ['http', 'https'], true) || $host === '' || filter_var($url, FILTER_VALIDATE_URL) === false) {
        vanillia_json_error('FORBIDDEN_URL_SCHEME', 'Only http:// and https:// URLs are allowed.');
    }

    return $url;
}

switch ($action) {
    case 'list':
        $stmt = $pdo->prepare(
            'SELECT * FROM desktop_shortcuts
             WHERE app_type = "shortcut" AND user_id = :uid
             ORDER BY sort_order ASC, id DESC'
        );
        $stmt->execute([':uid' => (int) $user['id']]);
        vanillia_json_success(['shortcuts' => $stmt->fetchAll()]);

    case 'save':
        $body = vanillia_read_body();
        $id = isset($body['id']) ? (int) $body['id'] : 0;
        $title = trim((string) ($body['title'] ?? ''));
        $url = validate_http_shortcut_url((string) ($body['url'] ?? ''));
        $openMode = trim((string) ($body['open_mode'] ?? 'external'));
        $icon = trim((string) ($body['icon'] ?? 'globe'));
        $accentColor = trim((string) ($body['accent_color'] ?? '#0EA5E9'));
        $useFavicon = !empty($body['use_favicon']);

        if ($title === '' || mb_strlen($title) > 48) {
            vanillia_json_error('INVALID_TITLE', 'Shortcut title must be between 1 and 48 characters.');
        }

        if (!in_array($openMode, ['external', 'window', 'remote_browser'], true)) {
            vanillia_json_error('INVALID_OPEN_MODE', 'Allowed open modes: external, window, remote_browser.');
        }

        $allowedIcons = [
            'globe', 'server', 'harddrive', 'camera', 'home', 'file-code',
            'activity', 'shield', 'database', 'play', 'sparkles', 'link', 'layers', 'terminal', 'box',
        ];
        if (!in_array($icon, $allowedIcons, true)) {
            $icon = 'globe';
        }

        if (preg_match('/^#[0-9a-fA-F]{6}$/', $accentColor) !== 1) {
            $accentColor = '#0EA5E9';
        }

        $hostLabel = (string) (parse_url($url, PHP_URL_HOST) ?: $url);
        $iconUrl = null;
        if ($useFavicon) {
            $scheme = (string) parse_url($url, PHP_URL_SCHEME);
            $port = parse_url($url, PHP_URL_PORT);
            $origin = "{$scheme}://{$hostLabel}" . ($port ? ":{$port}" : '');
            $iconUrl = "{$origin}/favicon.ico";
        }

        $now = time();

        if ($id > 0) {
            $upd = $pdo->prepare(
                'UPDATE desktop_shortcuts
                 SET title = :t,
                     subtitle = :sub,
                     url = :u,
                     target_url = :tu,
                     icon = :ic,
                     icon_url = :icu,
                     accent_color = :ac,
                     open_mode = :om
                 WHERE id = :id AND user_id = :uid AND app_type = "shortcut"'
            );
            $upd->execute([
                ':t'   => $title,
                ':sub' => $hostLabel,
                ':u'   => $url,
                ':tu'  => $url,
                ':ic'  => $icon,
                ':icu' => $iconUrl,
                ':ac'  => strtoupper($accentColor),
                ':om'  => $openMode,
                ':id'  => $id,
                ':uid' => (int) $user['id'],
            ]);

            $q = $pdo->prepare('SELECT app_id FROM desktop_shortcuts WHERE id = :id LIMIT 1');
            $q->execute([':id' => $id]);
            $appId = (string) ($q->fetchColumn() ?: '');
        } else {
            $appId = 'shortcut-' . bin2hex(random_bytes(5));
            $ins = $pdo->prepare(
                'INSERT INTO desktop_shortcuts
                    (user_id, app_id, app_type, title, subtitle, icon, icon_url, accent_color, url, target_url, open_mode, pinned_desktop, pinned_dock, sort_order, created_at)
                 VALUES
                    (:uid, :aid, "shortcut", :t, :sub, :ic, :icu, :ac, :u, :tu, :om, 1, :dock, 250, :cat)'
            );
            $ins->execute([
                ':uid'  => (int) $user['id'],
                ':aid'  => $appId,
                ':t'    => $title,
                ':sub'  => $hostLabel,
                ':ic'   => $icon,
                ':icu'  => $iconUrl,
                ':ac'   => strtoupper($accentColor),
                ':u'    => $url,
                ':tu'   => $url,
                ':om'   => $openMode,
                ':dock' => !empty($body['pinned_dock']) ? 1 : 0,
                ':cat'  => $now,
            ]);
            $id = (int) $pdo->lastInsertId();
        }

        vanillia_audit_log((int) $user['id'], (string) $user['username'], 'shortcut.save', $url, ['mode' => $openMode]);

        vanillia_json_success([
            'saved'  => true,
            'id'     => $id,
            'app_id' => $appId,
        ]);

    case 'delete':
        $body = vanillia_read_body();
        $appId = trim((string) ($body['app_id'] ?? $_GET['app_id'] ?? ''));
        $id = (int) ($body['id'] ?? $_GET['id'] ?? 0);

        if ($id > 0) {
            $del = $pdo->prepare('DELETE FROM desktop_shortcuts WHERE id = :id AND user_id = :uid AND app_type = "shortcut"');
            $del->execute([':id' => $id, ':uid' => (int) $user['id']]);
        } elseif ($appId !== '') {
            $del = $pdo->prepare('DELETE FROM desktop_shortcuts WHERE app_id = :aid AND user_id = :uid AND app_type = "shortcut"');
            $del->execute([':aid' => $appId, ':uid' => (int) $user['id']]);
        } else {
            vanillia_json_error('MISSING_IDENTIFIER', 'Shortcut id or app_id required.');
        }

        vanillia_audit_log((int) $user['id'], (string) $user['username'], 'shortcut.delete', $appId ?: (string) $id);
        vanillia_json_success(['deleted' => true]);

    default:
        vanillia_json_error('UNKNOWN_SHORTCUT_ACTION', "Unknown shortcut action: {$action}", 404);
}
