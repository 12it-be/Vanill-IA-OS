<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Lightweight Caddy `forward_auth` Session Verification Endpoint
 * Returns HTTP 200 OK (+ X-Vanillia-User) exclusively when an authenticated,
 * unlocked Vanill-IA OS session cookie is present; returns HTTP 401 otherwise.
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

vanillia_start_session(false);

$userId = (int) ($_SESSION['user_id'] ?? 0);
$isLocked = !empty($_SESSION['locked']);

if ($userId <= 0 || $isLocked) {
    http_response_code(401);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo 'Unauthorized';
    exit;
}

$stmt = vanillia_db()->prepare('SELECT username FROM users WHERE id = :id LIMIT 1');
$stmt->execute([':id' => $userId]);
$username = $stmt->fetchColumn();

if ($username === false) {
    http_response_code(401);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Unauthorized';
    exit;
}

// Release session file lock immediately so concurrent WebSocket/static requests never wait
session_write_close();

http_response_code(200);
header('X-Vanillia-User: ' . preg_replace('/[^a-zA-Z0-9_.-]/', '', (string) $username));
header('Cache-Control: no-store');
echo 'OK';
exit;
