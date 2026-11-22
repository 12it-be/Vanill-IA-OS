<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Debian System Administration & Telemetry API
 * Covers: Pulse, Resource Monitor, SMART, Storage/LSBLK/Mount, Samba SMB,
 *         Network, UFW Firewall, Fail2ban, Tailscale, Systemd, APT, Shortcuts
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'pulse'));
$pdo = vanillia_db();
$agent = new AgentClient();

/**
 * Génère des métriques de secours cohérentes lorsque le daemon Linux n'est pas actif (mode dev).
 *
 * @return array<string, mixed>
 */
function fallback_dev_metrics(): array
{
    $load = function_exists('sys_getloadavg') ? (sys_getloadavg() ?: [0.22, 0.18, 0.14]) : [0.22, 0.18, 0.14];
    return [
        'cpu' => [
            'total_percent' => round(min(100.0, ((float) $load[0]) * 18.0 + 4.2), 1),
            'cores'         => ['cpu0' => 8.5, 'cpu1' => 5.2, 'cpu2' => 11.0, 'cpu3' => 4.1],
        ],
        'memory' => [
            'total'        => 8_589_934_592,
            'used'         => 2_415_919_104,
            'available'    => 6_174_015_488,
            'cached'       => 1_288_490_188,
            'buffers'      => 268_435_456,
            'used_percent' => 28.1,
            'swap_total'   => 2_147_483_648,
            'swap_used'    => 0,
            'swap_percent' => 0.0,
        ],
        'load_average' => [
            '1m'        => round((float) $load[0], 2),
            '5m'        => round((float) $load[1], 2),
            '15m'       => round((float) $load[2], 2),
            'processes' => 142,
        ],
        'network' => [
            'rx_rate_bps' => 0,
            'tx_rate_bps' => 0,
            'interfaces'  => [],
        ],
        'disks'        => [],
        'temperatures' => [],
    ];
}

try {
    switch ($action) {
        // ----------------------------------------------------------------------
        // 1. Télémétrie légère Topbar & Moniteur de Ressources Complet
        // ----------------------------------------------------------------------
        case 'pulse':
            $user = vanillia_require_auth(false, false);
            $unreadStmt = $pdo->prepare('SELECT COUNT(*) FROM notifications WHERE is_read = 0 AND (user_id IS NULL OR user_id = :uid)');
            $unreadStmt->execute([':uid' => (int) $user['id']]);
            $unreadCount = (int) $unreadStmt->fetchColumn();
            $metrics = null;
            $agentOnline = false;

            if ($agent->isAvailable()) {
                try {
                    $metrics = $agent->getSystemMetrics();
                    $agentOnline = true;
                } catch (Throwable) {
                    $agentOnline = false;
                }
            }

            vanillia_json_success([
                'agent_online'         => $agentOnline,
                'hostname'             => gethostname() ?: 'debian',
                'metrics'              => $metrics ?? fallback_dev_metrics(),
                'unread_notifications' => $unreadCount,
                'server_time'          => gmdate('Y-m-d\TH:i:s\Z'),
            ]);

        case 'metrics_full':
            $user = vanillia_require_auth(false, false);
            if ($agent->isAvailable()) {
                $metrics = $agent->getSystemMetrics();
                $info = $agent->getSystemInfo();
                vanillia_json_success([
                    'agent_online' => true,
                    'info'         => $info,
                    'metrics'      => $metrics,
                ]);
            }

            vanillia_json_success([
                'agent_online' => false,
                'info'         => [
                    'hostname'      => gethostname() ?: 'debian',
                    'os_name'       => PHP_OS_FAMILY . ' (Mode Développement)',
                    'kernel'        => php_uname('r'),
                    'arch'          => php_uname('m'),
                    'cpu_model'     => 'Processeur Hôte',
                    'cpu_cores'     => 4,
                    'memory_total'  => 8_589_934_592,
                    'uptime_sec'    => 7200,
                    'ip_addresses'  => ['127.0.0.1'],
                    'php_version'   => PHP_VERSION,
                    'caddy_version' => null,
                    'docker_ready'  => false,
                ],
                'metrics'      => fallback_dev_metrics(),
            ]);

        case 'smart':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success(['available' => false, 'disks' => []]);
            }
            vanillia_json_success($agent->call('system.smart', [], 15));

        case 'info':
            $user = vanillia_require_auth();
            if ($agent->isAvailable()) {
                vanillia_json_success($agent->getSystemInfo());
            }
            vanillia_json_success([
                'hostname'      => gethostname() ?: 'debian',
                'os_name'       => PHP_OS_FAMILY . ' (Mode Développement)',
                'kernel'        => php_uname('r'),
                'arch'          => php_uname('m'),
                'cpu_model'     => 'Environnement Local',
                'cpu_cores'     => 4,
                'memory_total'  => 8_589_934_592,
                'uptime_sec'    => 3600,
                'ip_addresses'  => ['127.0.0.1'],
                'php_version'   => PHP_VERSION,
                'caddy_version' => null,
                'docker_ready'  => false,
                'agent_version' => VANILLIA_VERSION,
            ]);

        // ----------------------------------------------------------------------
        // 2. Stockage (lsblk, mount, umount) & Partages Samba SMB
        // ----------------------------------------------------------------------
        case 'storage_overview':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'blockdevices' => [],
                    'samba'        => ['installed' => false, 'shares' => []],
                ]);
            }
            $lsblk = $agent->call('storage.lsblk', [], 10);
            $samba = $agent->call('storage.samba.list', [], 8);
            vanillia_json_success([
                'blockdevices' => $lsblk['blockdevices'] ?? [],
                'samba'        => $samba,
            ]);

        case 'storage_mount':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('storage.mount', [
                'source' => $body['source'] ?? '',
                'folder' => $body['folder'] ?? '',
            ], 20);
            $mp = (string) ($res['mountpoint'] ?? ('/mnt/' . ($body['folder'] ?? '')));
            push_system_notification($pdo, (int) $user['id'], 'success', 'Disk volume mounted', sprintf('%s mounted at %s', (string) ($body['source'] ?? 'device'), $mp), null, null, 'storage', ['app' => 'file-station', 'path' => $mp]);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'storage.mount', (string) ($body['source'] ?? ''));
            vanillia_json_success($res);

        case 'storage_umount':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('storage.umount', [
                'mountpoint' => $body['mountpoint'] ?? '',
            ], 20);
            push_system_notification($pdo, (int) $user['id'], 'info', 'Disk volume unmounted', sprintf('Unmounted %s', (string) ($body['mountpoint'] ?? '')), null, null, 'storage');
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'storage.umount', (string) ($body['mountpoint'] ?? ''));
            vanillia_json_success($res);

        case 'samba_save':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('storage.samba.save', [
                'shares' => $body['shares'] ?? [],
            ], 20);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'storage.samba.save');
            vanillia_json_success($res);

        // ----------------------------------------------------------------------
        // 3. Réseau, Pare-feu UFW, Fail2ban & VPN Tailscale
        // ----------------------------------------------------------------------
        case 'network_security':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'network'   => ['interfaces' => [], 'routes' => [], 'nameservers' => []],
                    'ufw'       => ['installed' => false, 'active' => false, 'rules' => []],
                    'fail2ban'  => ['installed' => false, 'running' => false, 'jails' => []],
                    'tailscale' => ['installed' => false],
                ]);
            }

            vanillia_json_success([
                'network'   => $agent->call('network.interfaces', [], 8),
                'ufw'       => $agent->call('security.ufw.status', [], 10),
                'fail2ban'  => $agent->call('security.fail2ban.status', [], 10),
                'tailscale' => $agent->call('security.tailscale.status', [], 8),
            ]);

        case 'ufw_toggle':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $enable = !empty($body['enable']);
            $res = $agent->call('security.ufw.toggle', ['enable' => $enable], 15);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.ufw.toggle', $enable ? 'enable' : 'disable');
            vanillia_json_success($res);

        case 'ufw_rule':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('security.ufw.rule', [
                'operation' => $body['operation'] ?? 'allow',
                'port'      => $body['port'] ?? '',
                'proto'     => $body['proto'] ?? 'tcp',
                'number'    => $body['number'] ?? 0,
            ], 15);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.ufw.rule', (string) ($body['operation'] ?? ''));
            vanillia_json_success($res);

        case 'fail2ban_unban':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('security.fail2ban.unban', [
                'jail' => $body['jail'] ?? '',
                'ip'   => $body['ip'] ?? '',
            ], 12);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.fail2ban.unban', (string) ($body['ip'] ?? ''));
            vanillia_json_success($res);

        case 'tailscale_action':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $subCmd = (string) ($body['subcommand'] ?? '');
            $res = $agent->call('security.tailscale.action', [
                'subcommand' => $subCmd,
                'authkey'    => $body['authkey'] ?? '',
            ], 25);
            push_system_notification(
                $pdo,
                (int) $user['id'],
                $subCmd === 'up' ? 'success' : 'warning',
                $subCmd === 'up' ? 'Tailscale VPN connected' : 'Tailscale VPN disconnected',
                sprintf('Tailscale mesh state updated (%s).', $subCmd ?: 'status'),
                null,
                null,
                'tailscale'
            );
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.tailscale', $subCmd);
            vanillia_json_success($res);

        case 'network_exposure':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $mode = (string) ($body['mode'] ?? 'all');
            $res = $agent->call('caddy.exposure.save', ['mode' => $mode], 20);
            push_system_notification(
                $pdo,
                (int) $user['id'],
                'info',
                'WebOS Network Isolation updated',
                "Caddy Guard policy set to '{$mode}'.",
                null,
                null,
                'network'
            );
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.network_exposure', $mode);
            vanillia_json_success($res);

        // ----------------------------------------------------------------------
        // 4. Unités Systemd & Gestionnaire de Mises à Jour APT
        // ----------------------------------------------------------------------
        case 'services_list':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success(['services' => []]);
            }
            $search = trim((string) ($_GET['search'] ?? ''));
            vanillia_json_success($agent->call('service.list', ['search' => $search], 12));

        case 'service_action':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $unit = trim((string) ($body['unit'] ?? ''));
            $op = trim((string) ($body['operation'] ?? ''));
            $res = $agent->call('service.action', ['unit' => $unit, 'operation' => $op], 35);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], "systemd.{$op}", $unit);
            vanillia_json_success($res);

        case 'service_logs':
            $user = vanillia_require_auth();
            $unit = trim((string) ($_GET['unit'] ?? ''));
            $lines = max(20, min(500, (int) ($_GET['lines'] ?? 150)));
            vanillia_json_success($agent->call('service.logs', ['unit' => $unit, 'lines' => $lines], 12));

        case 'apt_status':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success(['upgradable_count' => 0, 'packages' => [], 'reboot_required' => false]);
            }
            $refresh = !empty($_GET['refresh']);
            vanillia_json_success($agent->call('apt.status', ['refresh' => $refresh], $refresh ? 95 : 25));

        case 'apt_upgrade':
            $user = vanillia_require_admin();
            $res = $agent->call('apt.upgrade', [], 610);
            push_system_notification(
                $pdo,
                (int) $user['id'],
                'success',
                'APT system upgrade completed',
                !empty($res['reboot_required'])
                    ? 'System packages upgraded. A server reboot is recommended.'
                    : 'All eligible system packages were upgraded successfully.',
                null,
                null,
                'apt'
            );
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'apt.upgrade');
            vanillia_json_success($res);

        // ----------------------------------------------------------------------
        // 5. Raccourcis Bureau, Notifications & Alimentation
        // ----------------------------------------------------------------------
        case 'shortcuts':
            $user = vanillia_require_auth();
            $stmt = $pdo->prepare(
                'SELECT * FROM desktop_shortcuts
                 WHERE user_id IS NULL OR user_id = :uid
                 ORDER BY sort_order ASC, id ASC'
            );
            $stmt->execute([':uid' => (int) $user['id']]);
            $rows = $stmt->fetchAll();

            $shortcuts = array_map(static fn (array $r): array => [
                'id'             => (int) $r['id'],
                'user_id'        => $r['user_id'] !== null ? (int) $r['user_id'] : null,
                'app_id'         => (string) $r['app_id'],
                'app_type'       => (string) $r['app_type'],
                'title'          => (string) $r['title'],
                'subtitle'       => (string) $r['subtitle'],
                'icon'           => (string) $r['icon'],
                'icon_url'       => $r['icon_url'] ?? null,
                'accent_color'   => (string) $r['accent_color'],
                'url'            => $r['url'] ?? $r['target_url'] ?? null,
                'target_url'     => $r['target_url'] ?? $r['url'] ?? null,
                'container_name' => $r['container_name'],
                'open_mode'      => (string) $r['open_mode'],
                'pinned_desktop' => ((int) $r['pinned_desktop']) === 1,
                'pinned_dock'    => ((int) $r['pinned_dock']) === 1,
                'sort_order'     => (int) $r['sort_order'],
            ], $rows);

            vanillia_json_success([
                'shortcuts' => array_merge($shortcuts, vanillia_discover_plugins()),
            ]);

        case 'shortcut_toggle_dock':
            $user = vanillia_require_auth();
            $body = vanillia_read_body();
            $appId = trim((string) ($body['app_id'] ?? ''));
            $pinned = !empty($body['pinned_dock']) ? 1 : 0;

            $upd = $pdo->prepare('UPDATE desktop_shortcuts SET pinned_dock = :p WHERE app_id = :aid AND (user_id IS NULL OR user_id = :uid)');
            $upd->execute([':p' => $pinned, ':aid' => $appId, ':uid' => (int) $user['id']]);
            vanillia_json_success(['app_id' => $appId, 'pinned_dock' => $pinned === 1]);

        case 'shortcut_pin_webapp':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();

            $appId = strtolower(trim((string) ($body['app_id'] ?? '')));
            $title = trim((string) ($body['title'] ?? ''));
            $targetUrl = trim((string) ($body['target_url'] ?? ''));
            $openMode = in_array($body['open_mode'] ?? '', ['iframe', 'tab'], true) ? (string) $body['open_mode'] : 'iframe';
            $icon = trim((string) ($body['icon'] ?? 'globe'));
            $accent = preg_match('/^#[0-9a-fA-F]{6}$/', (string) ($body['accent_color'] ?? '')) === 1 ? (string) $body['accent_color'] : '#0EA5E9';

            if (preg_match('/^[a-z0-9_-]{2,48}$/', $appId) !== 1 || $title === '' || $targetUrl === '') {
                vanillia_json_error('INVALID_SHORTCUT', 'Paramètres de raccourci invalides.');
            }

            $stmt = $pdo->prepare(
                'INSERT INTO desktop_shortcuts (user_id, app_id, app_type, title, subtitle, icon, accent_color, target_url, container_name, open_mode, pinned_desktop, pinned_dock, sort_order)
                 VALUES (:uid, :aid, :type, :title, :sub, :icon, :acc, :url, :cname, :mode, 1, :dock, 200)
                 ON CONFLICT(COALESCE(user_id, 0), app_id) DO UPDATE SET
                    title = excluded.title,
                    target_url = excluded.target_url,
                    open_mode = excluded.open_mode,
                    pinned_dock = excluded.pinned_dock'
            );
            $stmt->execute([
                ':uid'   => (int) $user['id'],
                ':aid'   => $appId,
                ':type'  => !empty($body['container_name']) ? 'docker' : 'webapp',
                ':title' => substr($title, 0, 40),
                ':sub'   => substr(trim((string) ($body['subtitle'] ?? 'Application Web / Docker')), 0, 60),
                ':icon'  => $icon,
                ':acc'   => $accent,
                ':url'   => $targetUrl,
                ':cname' => $body['container_name'] ?? null,
                ':mode'  => $openMode,
                ':dock'  => !empty($body['pinned_dock']) ? 1 : 0,
            ]);

            vanillia_json_success(['saved' => true, 'app_id' => $appId]);

        case 'shortcut_delete':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $appId = trim((string) ($body['app_id'] ?? ''));

            $del = $pdo->prepare('DELETE FROM desktop_shortcuts WHERE app_id = :aid AND app_type != "system"');
            $del->execute([':aid' => $appId]);
            vanillia_json_success(['deleted' => true, 'app_id' => $appId]);

        case 'notifications':
            $user = vanillia_require_auth(false, false);
            $rows = $pdo->query('SELECT * FROM notifications ORDER BY id DESC LIMIT 40')->fetchAll();
            vanillia_json_success(['notifications' => $rows]);

        case 'notifications_read':
            $user = vanillia_require_auth();
            $body = vanillia_read_body();
            if (!empty($body['id'])) {
                $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE id = :id')->execute([':id' => (int) $body['id']]);
            } else {
                $pdo->exec('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
            }
            vanillia_json_success(['marked_read' => true]);

        case 'notifications_clear':
            $user = vanillia_require_auth();
            $pdo->exec('DELETE FROM notifications');
            vanillia_json_success(['cleared' => true]);

        case 'audit_logs':
            $user = vanillia_require_admin();
            $rows = $pdo->query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100')->fetchAll();
            vanillia_json_success(['logs' => $rows]);

        case 'power':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $mode = (string) ($body['mode'] ?? '');
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'system.power', $mode);
            vanillia_json_success($agent->call('system.power', ['mode' => $mode], 10));

        default:
            vanillia_json_error('UNKNOWN_SYSTEM_ACTION', "Action système inconnue : {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
