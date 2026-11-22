<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — User Preferences, Language (`i18n`), Desktop Layout & Window Rects
 * Endpoint: /api/settings.php
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$user = vanillia_require_auth();
$action = trim((string) ($_GET['action'] ?? 'get'));
$pdo = vanillia_db();

/**
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function settings_format_user(array $row): array
{
    $prefs = json_decode((string) ($row['desktop_prefs_json'] ?? '{}'), true);
    return [
        'id'                   => (int) $row['id'],
        'username'             => (string) $row['username'],
        'display_name'         => (string) $row['display_name'],
        'role'                 => (string) $row['role'],
        'totp_enabled'         => ((int) ($row['totp_enabled'] ?? 0)) === 1,
        'session_lock_minutes' => (int) ($row['session_lock_minutes'] ?? 15),
        'language'             => in_array($row['language'] ?? 'en', ['en', 'fr'], true) ? (string) $row['language'] : 'en',
        'theme_mode'           => (string) ($row['theme_mode'] ?? 'dark'),
        'wallpaper'            => (string) ($row['wallpaper'] ?? 'aurora-coral'),
        'accent_color'         => (string) ($row['accent_color'] ?? '#FF6D5A'),
        'desktop_prefs'        => is_array($prefs) ? $prefs : [],
    ];
}

switch ($action) {
    case 'get':
        vanillia_json_success([
            'user' => settings_format_user($user),
            'os'   => [
                'name'             => vanillia_get_setting('os.name', 'Vanill-IA OS'),
                'network_exposure' => vanillia_get_setting('security.network_exposure', 'all'),
            ],
        ]);

    // Mise à jour immédiate de la langue utilisateur (`en` | `fr`) et/ou préférences d'apparence
    case 'language':
    case 'preferences':
        $body = vanillia_read_body();

        $language = in_array($body['language'] ?? '', ['en', 'fr'], true)
            ? (string) $body['language']
            : (string) ($user['language'] ?? 'en');

        $themeMode = in_array($body['theme_mode'] ?? '', ['dark', 'light', 'auto'], true)
            ? (string) $body['theme_mode']
            : (string) $user['theme_mode'];

        $wallpaper = isset($body['wallpaper']) && preg_match('/^[a-z0-9_-]{2,32}$/', (string) $body['wallpaper']) === 1
            ? (string) $body['wallpaper']
            : (string) $user['wallpaper'];

        $accentColor = isset($body['accent_color']) && preg_match('/^#[0-9a-fA-F]{6}$/', (string) $body['accent_color']) === 1
            ? strtoupper((string) $body['accent_color'])
            : (string) $user['accent_color'];

        $lockMinutes = isset($body['session_lock_minutes'])
            ? max(0, min(1440, (int) $body['session_lock_minutes']))
            : (int) $user['session_lock_minutes'];

        $prefs = json_decode((string) ($user['desktop_prefs_json'] ?? '{}'), true) ?: [];
        if (isset($body['desktop_prefs']) && is_array($body['desktop_prefs'])) {
            $prefs = array_merge($prefs, $body['desktop_prefs']);
        }

        $stmt = $pdo->prepare(
            'UPDATE users
             SET language = :lg,
                 theme_mode = :tm,
                 wallpaper = :wp,
                 accent_color = :ac,
                 session_lock_minutes = :sl,
                 desktop_prefs_json = :dp,
                 updated_at = :u
             WHERE id = :id'
        );
        $stmt->execute([
            ':lg' => $language,
            ':tm' => $themeMode,
            ':wp' => $wallpaper,
            ':ac' => $accentColor,
            ':sl' => $lockMinutes,
            ':dp' => json_encode($prefs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ':u'  => gmdate('Y-m-d H:i:s'),
            ':id' => (int) $user['id'],
        ]);

        $_SESSION['session_lock_minutes'] = $lockMinutes;

        $fresh = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $fresh->execute([':id' => (int) $user['id']]);
        vanillia_json_success(['user' => settings_format_user($fresh->fetch() ?: $user)]);

    // Persistance par utilisateur de l'ordre des icônes, des icônes masquées et des coordonnées fenêtres
    case 'desktop_layout':
        $body = vanillia_read_body();
        $prefs = json_decode((string) ($user['desktop_prefs_json'] ?? '{}'), true) ?: [];

        if (isset($body['desktop_order']) && is_array($body['desktop_order'])) {
            $cleanOrder = [];
            foreach ($body['desktop_order'] as $item) {
                if (is_string($item) && preg_match('/^[a-zA-Z0-9:_-]{2,64}$/', $item) === 1) {
                    $cleanOrder[] = $item;
                }
            }
            $prefs['desktopOrder'] = array_values(array_unique($cleanOrder));
        }

        if (isset($body['hidden_desktop_apps']) && is_array($body['hidden_desktop_apps'])) {
            $cleanHidden = [];
            foreach ($body['hidden_desktop_apps'] as $item) {
                if (is_string($item) && preg_match('/^[a-zA-Z0-9:_-]{2,64}$/', $item) === 1) {
                    $cleanHidden[] = $item;
                }
            }
            $prefs['hiddenDesktopApps'] = array_values(array_unique($cleanHidden));
        }

        if (isset($body['pinned_plugin_dock']) && is_array($body['pinned_plugin_dock'])) {
            $cleanDock = [];
            foreach ($body['pinned_plugin_dock'] as $item) {
                if (is_string($item) && preg_match('/^[a-zA-Z0-9:_-]{2,64}$/', $item) === 1) {
                    $cleanDock[] = $item;
                }
            }
            $prefs['pinnedPluginDock'] = array_values(array_unique($cleanDock));
        }

        if (array_key_exists('window_rects', $body)) {
            if ($body['window_rects'] === null || $body['window_rects'] === []) {
                $prefs['windowRects'] = new stdClass();
            } elseif (is_array($body['window_rects'])) {
                $cleanRects = [];
                foreach ($body['window_rects'] as $appId => $rect) {
                    if (is_string($appId) && is_array($rect) && preg_match('/^[a-zA-Z0-9:_-]{2,64}$/', $appId) === 1) {
                        $cleanRects[$appId] = [
                            'left'   => (int) ($rect['left'] ?? 80),
                            'top'    => (int) ($rect['top'] ?? 40),
                            'width'  => max(320, (int) ($rect['width'] ?? 900)),
                            'height' => max(240, (int) ($rect['height'] ?? 580)),
                        ];
                    }
                }
                $prefs['windowRects'] = $cleanRects;
            }
        }

        $stmt = $pdo->prepare('UPDATE users SET desktop_prefs_json = :dp, updated_at = :u WHERE id = :id');
        $stmt->execute([
            ':dp' => json_encode($prefs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ':u'  => gmdate('Y-m-d H:i:s'),
            ':id' => (int) $user['id'],
        ]);

        $fresh = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $fresh->execute([':id' => (int) $user['id']]);
        vanillia_json_success(['user' => settings_format_user($fresh->fetch() ?: $user)]);

    default:
        vanillia_json_error('UNKNOWN_SETTINGS_ACTION', "Unknown settings action: {$action}", 404);
}
