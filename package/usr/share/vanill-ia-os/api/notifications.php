<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Unified Notification Center API (/api/notifications.php)
 * Actions:
 *   - GET  ?action=list   : Returns recent notifications + unread count
 *   - POST ?action=create : Persists a user/UI event into the Bell history
 *   - POST ?action=read   : Marks one (`id`) or all notifications as read
 *   - POST ?action=clear  : Deletes notifications
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$action = trim((string) ($_GET['action'] ?? ''));

if ($action === '') {
    $bodyPeek = $method === 'POST' ? vanillia_read_body() : [];
    $action = isset($bodyPeek['action']) && is_string($bodyPeek['action'])
        ? trim($bodyPeek['action'])
        : ($method === 'POST' ? 'create' : ($method === 'DELETE' ? 'clear' : 'list'));
}

$touchSession = $action !== 'list';
$user = vanillia_require_auth(false, $touchSession);
$pdo = vanillia_db();
$uid = (int) $user['id'];

/**
 * Counts unread notifications visible to the current user.
 */
function count_user_unread_notifications(PDO $pdo, int $uid): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM notifications WHERE is_read = 0 AND (user_id IS NULL OR user_id = :uid)');
    $stmt->execute([':uid' => $uid]);
    return (int) $stmt->fetchColumn();
}

/**
 * Lists recent notifications visible to the current user.
 *
 * @return list<array<string, mixed>>
 */
function list_user_notifications(PDO $pdo, int $uid, int $limit = 50): array
{
    $stmt = $pdo->prepare(
        'SELECT * FROM notifications
         WHERE user_id IS NULL OR user_id = :uid
         ORDER BY id DESC
         LIMIT :lim'
    );
    $stmt->bindValue(':uid', $uid, PDO::PARAM_INT);
    $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll();
}

switch ($action) {
    case 'list':
        vanillia_json_success([
            'unread_count'  => count_user_unread_notifications($pdo, $uid),
            'notifications' => list_user_notifications($pdo, $uid),
        ]);

    case 'create':
        $body = vanillia_read_body();
        $level = (string) ($body['level'] ?? 'info');
        $title = trim((string) ($body['title'] ?? 'Notification'));
        $message = trim((string) ($body['message'] ?? ''));
        $actionUrl = isset($body['action_url']) && is_string($body['action_url']) ? trim($body['action_url']) : null;
        $actionLabel = isset($body['action_label']) && is_string($body['action_label']) ? trim($body['action_label']) : null;
        $source = isset($body['source']) && is_string($body['source']) ? trim($body['source']) : 'ui';
        $payload = isset($body['action_payload']) && is_array($body['action_payload']) ? $body['action_payload'] : null;

        if ($title === '' && $message === '') {
            vanillia_json_error('EMPTY_NOTIFICATION', 'Notification title or message is required.');
        }
        if ($title === '') {
            $title = mb_substr($message, 0, 80);
        }

        // Validate optional action_url (only http://, https://, or local /... paths)
        if ($actionUrl !== null && $actionUrl !== '') {
            $isLocalPath = str_starts_with($actionUrl, '/') && !str_starts_with($actionUrl, '//');
            $scheme = strtolower((string) parse_url($actionUrl, PHP_URL_SCHEME));
            $isHttp = in_array($scheme, ['http', 'https'], true) && filter_var($actionUrl, FILTER_VALIDATE_URL) !== false;
            if (!$isLocalPath && !$isHttp) {
                $actionUrl = null;
            }
        }

        $newId = push_system_notification(
            $pdo,
            $uid,
            $level,
            $title,
            $message,
            $actionUrl,
            $actionLabel,
            $source,
            $payload
        );

        vanillia_json_success([
            'id'            => $newId,
            'unread_count'  => count_user_unread_notifications($pdo, $uid),
            'notifications' => list_user_notifications($pdo, $uid),
        ], 201);

    case 'read':
        $body = vanillia_read_body();
        if (!empty($body['id'])) {
            $stmt = $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE id = :id AND (user_id IS NULL OR user_id = :uid)');
            $stmt->execute([':id' => (int) $body['id'], ':uid' => $uid]);
        } else {
            $stmt = $pdo->prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND (user_id IS NULL OR user_id = :uid)');
            $stmt->execute([':uid' => $uid]);
        }

        vanillia_json_success([
            'marked_read'  => true,
            'unread_count' => count_user_unread_notifications($pdo, $uid),
        ]);

    case 'clear':
        $stmt = $pdo->prepare('DELETE FROM notifications WHERE user_id IS NULL OR user_id = :uid');
        $stmt->execute([':uid' => $uid]);

        vanillia_json_success([
            'cleared'      => true,
            'unread_count' => 0,
        ]);

    default:
        vanillia_json_error('UNKNOWN_NOTIFICATION_ACTION', "Unknown notification action: {$action}", 404);
}
