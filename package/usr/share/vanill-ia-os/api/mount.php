<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Native SMB/CIFS Mount Manager API (/api/mount.php)
 * Delegates privileged `mount -t cifs` / `umount` / `findmnt` to `vanill-ia-agent`
 * with ephemeral `/tmp/.smb-cred-XXXX` unlinked immediately after mount.
 * Never logs or persists SMB passwords in SQLite or audit logs.
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'status'));
$pdo = vanillia_db();
$agent = new AgentClient();

try {
    switch ($action) {
        case 'status':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'agent_online'   => false,
                    'cifs_installed' => false,
                    'mounts'         => [],
                ]);
            }

            $res = $agent->call('cifs.status', [], 10);
            vanillia_json_success([
                'agent_online'   => true,
                'cifs_installed' => !empty($res['cifs_installed']),
                'mounts'         => $res['mounts'] ?? [],
            ]);

        case 'mount':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();

            $host = trim((string) ($body['host'] ?? ''));
            $share = trim((string) ($body['share'] ?? ''));
            $mountpoint = trim((string) ($body['mountpoint'] ?? ''));

            $res = $agent->call('cifs.mount', [
                'host'       => $host,
                'share'      => $share,
                'mountpoint' => $mountpoint,
                'username'   => (string) ($body['username'] ?? ''),
                'password'   => (string) ($body['password'] ?? ''),
                'domain'     => (string) ($body['domain'] ?? ''),
                'vers'       => (string) ($body['vers'] ?? 'auto'),
                'read_only'  => !empty($body['read_only']),
            ], 30);

            push_system_notification(
                $pdo,
                (int) $user['id'],
                'success',
                'SMB/CIFS share mounted',
                "//{$host}/{$share} mounted at {$mountpoint}",
                null,
                null,
                'mount',
                ['app' => 'file-station', 'path' => $mountpoint]
            );

            // Audit trace WITHOUT credentials
            vanillia_audit_log(
                (int) $user['id'],
                (string) $user['username'],
                'cifs.mount',
                "//{$host}/{$share} -> {$mountpoint}"
            );

            vanillia_json_success($res);

        case 'umount':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $mountpoint = trim((string) ($body['mountpoint'] ?? ''));

            $res = $agent->call('cifs.umount', [
                'mountpoint' => $mountpoint,
                'lazy'       => !empty($body['lazy']),
            ], 20);

            push_system_notification(
                $pdo,
                (int) $user['id'],
                'info',
                'SMB/CIFS share unmounted',
                "Unmounted {$mountpoint}",
                null,
                null,
                'mount'
            );

            vanillia_audit_log(
                (int) $user['id'],
                (string) $user['username'],
                'cifs.umount',
                $mountpoint
            );

            vanillia_json_success($res);

        default:
            vanillia_json_error('UNKNOWN_MOUNT_ACTION', "Unknown mount action: {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
