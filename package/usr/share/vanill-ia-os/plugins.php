<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Authenticated Dynamic Plugin Asset Gateway
 * Serves `/var/lib/vanill-ia-os/apps/<plugin>/<file>` via `/plugins.php/<plugin>/<file>`
 * so plugins loaded in `"launchMode": "window"` inherit the authenticated session,
 * support relative paths (`./style.css`, `./app.js`) and require zero `.deb` rebuild.
 * ==============================================================================
 */

require_once __DIR__ . '/api/bootstrap.php';

vanillia_require_auth();

$pathInfo = ltrim((string) ($_SERVER['PATH_INFO'] ?? ''), '/');
$pluginFolder = '';
$relFile = '';

if ($pathInfo !== '') {
    $parts = explode('/', $pathInfo, 2);
    $pluginFolder = $parts[0] ?? '';
    $relFile = $parts[1] ?? 'index.html';
} else {
    $pluginFolder = trim((string) ($_GET['plugin'] ?? ''));
    $relFile = ltrim(trim((string) ($_GET['file'] ?? 'index.html')), '/');
}

if (preg_match('/^[a-zA-Z0-9_-]{2,48}$/', $pluginFolder) !== 1 || $relFile === '' || str_contains($relFile, '..')) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Invalid plugin path.';
    exit;
}

$pluginBase = realpath(vanillia_plugins_dir() . '/' . $pluginFolder);
if ($pluginBase === false || !is_dir($pluginBase)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Plugin not found.';
    exit;
}

$targetFile = realpath($pluginBase . '/' . $relFile);
if ($targetFile === false || !is_file($targetFile) || !str_starts_with($targetFile, $pluginBase . DIRECTORY_SEPARATOR)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Plugin asset not found.';
    exit;
}

$ext = strtolower(pathinfo($targetFile, PATHINFO_EXTENSION));
$mimeTypes = [
    'html' => 'text/html; charset=utf-8',
    'htm'  => 'text/html; charset=utf-8',
    'css'  => 'text/css; charset=utf-8',
    'js'   => 'application/javascript; charset=utf-8',
    'mjs'  => 'application/javascript; charset=utf-8',
    'json' => 'application/json; charset=utf-8',
    'svg'  => 'image/svg+xml',
    'png'  => 'image/png',
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'gif'  => 'image/gif',
    'ico'  => 'image/x-icon',
    'woff' => 'font/woff',
    'woff2'=> 'font/woff2',
];

header('Content-Type: ' . ($mimeTypes[$ext] ?? 'application/octet-stream'));
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Cache-Control: no-cache');
readfile($targetFile);
exit;
