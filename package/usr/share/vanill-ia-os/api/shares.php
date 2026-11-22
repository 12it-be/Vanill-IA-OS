<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Public File Sharing Management API (/api/shares.php)
 * Authenticated endpoints:
 *   - GET    /api/shares.php                 -> List shares with status & counts
 *   - POST   /api/shares.php (?action=create)-> Create public share link
 *   - DELETE /api/shares.php (?action=revoke)-> Immediately revoke share link
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$user = vanillia_require_auth();
$pdo = vanillia_db();
$agent = new AgentClient();

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$action = trim((string) ($_GET['action'] ?? ''));

if ($action === '') {
    $action = match ($method) {
        'POST'   => 'create',
        'DELETE' => 'revoke',
        default  => 'list',
    };
}

/**
 * Builds the canonical public base URL (`https://<host>` or `http://<host>`).
 */
function vanillia_public_base_url(): string
{
    $isHttps = vanillia_is_https();
    $scheme = $isHttps ? 'https' : 'http';

    $rawHost = !empty($_SERVER['HTTP_X_FORWARDED_HOST'])
        ? trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_HOST'])[0])
        : (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');

    $host = preg_replace('/[^a-zA-Z0-9.:_-]/', '', $rawHost) ?: 'localhost';
    return "{$scheme}://{$host}";
}

try {
    switch ($action) {
        case 'list':
            $now = time();
            $isAdmin = (($user['role'] ?? '') === 'admin');

            if ($isAdmin) {
                $rows = $pdo->query(
                    'SELECT s.*, u.username AS creator_username
                     FROM file_shares s
                     LEFT JOIN users u ON u.id = s.created_by
                     ORDER BY s.created_at DESC'
                )->fetchAll();
            } else {
                $stmt = $pdo->prepare(
                    'SELECT s.*, u.username AS creator_username
                     FROM file_shares s
                     LEFT JOIN users u ON u.id = s.created_by
                     WHERE s.created_by = :uid
                     ORDER BY s.created_at DESC'
                );
                $stmt->execute([':uid' => (int) $user['id']]);
                $rows = $stmt->fetchAll();
            }

            $baseUrl = vanillia_public_base_url();
            $shares = [];

            foreach ($rows as $r) {
                $expiresAt = $r['expires_at'] !== null ? (int) $r['expires_at'] : null;
                $maxDl = $r['max_downloads'] !== null ? (int) $r['max_downloads'] : null;
                $dlCount = (int) $r['download_count'];

                $expired = ($expiresAt !== null && $expiresAt <= $now);
                $exhausted = ($maxDl !== null && $dlCount >= $maxDl);

                $status = 'active';
                if ($expired) {
                    $status = 'expired';
                } elseif ($exhausted) {
                    $status = 'exhausted';
                }

                $shares[] = [
                    'id'               => (int) $r['id'],
                    'token'            => (string) $r['token'],
                    'share_url'        => $baseUrl . '/share.php?t=' . rawurlencode((string) $r['token']),
                    'file_path'        => (string) $r['file_path'],
                    'file_name'        => (string) $r['file_name'],
                    'file_size'        => (int) ($r['file_size'] ?? 0),
                    'has_password'     => !empty($r['password_hash']),
                    'expires_at'       => $expiresAt,
                    'max_downloads'    => $maxDl,
                    'download_count'   => $dlCount,
                    'status'           => $status,
                    'created_by'       => (int) $r['created_by'],
                    'creator_username' => (string) ($r['creator_username'] ?? ''),
                    'created_at'       => (int) $r['created_at'],
                ];
            }

            vanillia_json_success(['shares' => $shares]);

        case 'create':
            $body = vanillia_read_body();
            $rawPath = trim((string) ($body['file_path'] ?? ''));
            if ($rawPath === '' || str_contains($rawPath, "\0")) {
                vanillia_json_error('INVALID_FILE_PATH', 'A valid file path is required.');
            }

            // Canonical resolution & readability validation
            $realPath = false;
            $fileName = '';
            $fileSize = 0;

            if ($agent->isAvailable()) {
                $stat = $agent->call('fs.stat_share', ['path' => $rawPath], 10);
                $realPath = (string) $stat['real_path'];
                $fileName = (string) $stat['file_name'];
                $fileSize = (int) $stat['file_size'];
            } else {
                $candidate = realpath($rawPath);
                if ($candidate === false || !is_file($candidate) || !is_readable($candidate)) {
                    vanillia_json_error('FILE_NOT_FOUND', 'Target file does not exist or is not a readable regular file.', 404);
                }
                $blocked = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers'];
                if (in_array(str_replace('\\', '/', $candidate), $blocked, true) || str_starts_with($candidate, vanillia_data_dir())) {
                    vanillia_json_error('SECRET_FORBIDDEN', 'System security files cannot be shared.', 403);
                }
                $realPath = str_replace('\\', '/', $candidate);
                $fileName = basename($realPath);
                $fileSize = (int) filesize($candidate);
            }

            $password = trim((string) ($body['password'] ?? ''));
            $passwordHash = $password !== '' ? password_hash($password, PASSWORD_DEFAULT) : null;

            $now = time();
            $expiresAt = null;
            if (!empty($body['expires_in_seconds']) && (int) $body['expires_in_seconds'] > 0) {
                $expiresAt = $now + (int) $body['expires_in_seconds'];
            } elseif (!empty($body['expires_at']) && (int) $body['expires_at'] > $now) {
                $expiresAt = (int) $body['expires_at'];
            }

            $maxDownloads = null;
            if (isset($body['max_downloads']) && $body['max_downloads'] !== '' && $body['max_downloads'] !== null) {
                $parsedMax = (int) $body['max_downloads'];
                if ($parsedMax >= 1) {
                    $maxDownloads = $parsedMax;
                }
            }

            // 40-char cryptographic random hexadecimal token (160 bits entropy)
            $token = bin2hex(random_bytes(20));

            $stmt = $pdo->prepare(
                'INSERT INTO file_shares
                    (token, file_path, file_name, file_size, password_hash, expires_at, max_downloads, download_count, created_by, created_at)
                 VALUES
                    (:tok, :fp, :fn, :fs, :ph, :exp, :maxd, 0, :cb, :cat)'
            );
            $stmt->execute([
                ':tok'  => $token,
                ':fp'   => $realPath,
                ':fn'   => $fileName,
                ':fs'   => $fileSize,
                ':ph'   => $passwordHash,
                ':exp'  => $expiresAt,
                ':maxd' => $maxDownloads,
                ':cb'   => (int) $user['id'],
                ':cat'  => $now,
            ]);

            $shareId = (int) $pdo->lastInsertId();
            $shareUrl = vanillia_public_base_url() . '/share.php?t=' . rawurlencode($token);

            $expNotice = $expiresAt !== null
                ? 'Expires ' . gmdate('Y-m-d H:i \U\T\C', $expiresAt)
                : 'No expiration';
            push_system_notification(
                $pdo,
                (int) $user['id'],
                'success',
                'Public share link created',
                "{$fileName} ({$expNotice})",
                $shareUrl,
                'Copy Link',
                'shares'
            );

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'share.create', $realPath, [
                'expires_at'    => $expiresAt,
                'max_downloads' => $maxDownloads,
                'protected'     => $passwordHash !== null,
            ]);

            vanillia_json_success([
                'id'            => $shareId,
                'token'         => $token,
                'share_url'     => $shareUrl,
                'file_name'     => $fileName,
                'file_size'     => $fileSize,
                'expires_at'    => $expiresAt,
                'max_downloads' => $maxDownloads,
                'has_password'  => $passwordHash !== null,
            ], 201);

        case 'revoke':
            $body = vanillia_read_body();
            $shareId = (int) ($body['id'] ?? $_GET['id'] ?? 0);
            if ($shareId <= 0) {
                vanillia_json_error('INVALID_SHARE_ID', 'Invalid share ID.');
            }

            $isAdmin = (($user['role'] ?? '') === 'admin');
            if ($isAdmin) {
                $del = $pdo->prepare('DELETE FROM file_shares WHERE id = :id');
                $del->execute([':id' => $shareId]);
            } else {
                $del = $pdo->prepare('DELETE FROM file_shares WHERE id = :id AND created_by = :uid');
                $del->execute([':id' => $shareId, ':uid' => (int) $user['id']]);
            }

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'share.revoke', (string) $shareId);
            vanillia_json_success(['revoked' => true, 'id' => $shareId]);

        default:
            vanillia_json_error('UNKNOWN_SHARE_ACTION', "Unknown share action: {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
