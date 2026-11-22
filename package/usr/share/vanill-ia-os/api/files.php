<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — File Station, Code Editor & Markdown Notes API
 * Supports: Secure Directory Listing, Text Read/Save, Drag & Drop Upload,
 *           Media Preview / Download, Zip/Unzip, Chmod/Chown & .md Notes
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'list'));
$pdo = vanillia_db();
$agent = new AgentClient();

/**
 * Résout le dossier de stockage des notes Markdown (.md).
 */
function vanillia_notes_dir(): string
{
    $configured = vanillia_get_setting('notes.storage_dir', '/var/lib/vanill-ia-os/notes');
    if (is_dir($configured) && is_writable($configured)) {
        return $configured;
    }
    $fallback = vanillia_data_dir() . '/notes';
    if (!is_dir($fallback)) {
        @mkdir($fallback, 0750, true);
    }
    return $fallback;
}

/**
 * Fallback local direct (si vanill-ia-agent n'est pas actif en mode dev).
 *
 * @return array<string, mixed>
 */
function local_fs_list(string $path, bool $showHidden): array
{
    $real = realpath($path);
    if ($real === false || !is_dir($real)) {
        vanillia_json_error('PATH_NOT_FOUND', 'Dossier introuvable.', 404);
    }
    $entries = @scandir($real) ?: [];
    $items = [];
    foreach ($entries as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        if (!$showHidden && str_starts_with($name, '.') && $name !== '.env') {
            continue;
        }
        $full = rtrim($real, DIRECTORY_SEPARATOR) . '/' . $name;
        $isDir = is_dir($full);
        $items[] = [
            'name'       => $name,
            'path'       => str_replace('\\', '/', $full),
            'is_dir'     => $isDir,
            'is_symlink' => is_link($full),
            'size'       => $isDir ? 0 : (int) @filesize($full),
            'mtime'      => (int) @filemtime($full),
            'mode'       => substr(sprintf('%o', (int) @fileperms($full)), -4),
            'owner'      => 'local',
            'group'      => 'local',
            'extension'  => $isDir ? '' : strtolower(pathinfo($name, PATHINFO_EXTENSION)),
        ];
    }
    usort($items, static fn (array $a, array $b): int => $a['is_dir'] !== $b['is_dir'] ? ($a['is_dir'] ? -1 : 1) : strnatcasecmp($a['name'], $b['name']));
    $norm = str_replace('\\', '/', $real);
    return [
        'path'   => $norm,
        'parent' => dirname($norm) !== $norm ? str_replace('\\', '/', dirname($real)) : null,
        'items'  => $items,
    ];
}

try {
    switch ($action) {
        // ======================================================================
        // 1. FILE STATION & CODE EDITOR
        // ======================================================================
        case 'list':
            $user = vanillia_require_admin();
            $path = trim((string) ($_GET['path'] ?? '/'));
            $showHidden = !empty($_GET['hidden']);

            if ($agent->isAvailable()) {
                vanillia_json_success($agent->call('fs.list', [
                    'path'        => $path,
                    'show_hidden' => $showHidden,
                ], 12));
            }
            vanillia_json_success(local_fs_list($path === '/' ? dirname(__DIR__) : $path, $showHidden));

        case 'read':
            $user = vanillia_require_admin();
            $path = trim((string) ($_GET['path'] ?? ''));

            if ($agent->isAvailable()) {
                vanillia_json_success($agent->call('fs.read', ['path' => $path], 12));
            }
            if (!is_file($path) || !is_readable($path)) {
                vanillia_json_error('NOT_FOUND', 'Fichier introuvable ou illisible.', 404);
            }
            vanillia_json_success([
                'path'    => $path,
                'size'    => (int) filesize($path),
                'mtime'   => (int) filemtime($path),
                'content' => (string) file_get_contents($path),
            ]);

        case 'write':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $path = trim((string) ($body['path'] ?? ''));
            $content = (string) ($body['content'] ?? '');

            if ($agent->isAvailable()) {
                $res = $agent->call('fs.write', [
                    'path'    => $path,
                    'content' => $content,
                ], 15);
            } else {
                if (@file_put_contents($path, $content) === false) {
                    vanillia_json_error('WRITE_FAILED', 'Échec d\'écriture locale.', 500);
                }
                $res = ['saved' => true, 'path' => $path, 'size' => strlen($content)];
            }

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.write', $path);
            vanillia_json_success($res);

        case 'mkdir':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $path = trim((string) ($body['path'] ?? ''));

            $res = $agent->call('fs.mkdir', ['path' => $path], 10);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.mkdir', $path);
            vanillia_json_success($res);

        case 'rename':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $from = trim((string) ($body['from'] ?? ''));
            $to = trim((string) ($body['to'] ?? ''));

            $res = $agent->call('fs.rename', ['from' => $from, 'to' => $to], 10);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.rename', "{$from} -> {$to}");
            vanillia_json_success($res);

        case 'delete':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $path = trim((string) ($body['path'] ?? ''));

            $res = $agent->call('fs.delete', ['path' => $path], 25);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.delete', $path);
            vanillia_json_success($res);

        case 'chmod':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('fs.chmod', [
                'path'      => $body['path'] ?? '',
                'mode'      => $body['mode'] ?? '0644',
                'recursive' => !empty($body['recursive']),
            ], 25);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.chmod', (string) ($body['path'] ?? ''));
            vanillia_json_success($res);

        case 'chown':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('fs.chown', [
                'path'      => $body['path'] ?? '',
                'owner'     => $body['owner'] ?? 'root',
                'group'     => $body['group'] ?? '',
                'recursive' => !empty($body['recursive']),
            ], 25);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.chown', (string) ($body['path'] ?? ''));
            vanillia_json_success($res);

        case 'archive':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $res = $agent->call('fs.archive', [
                'mode'        => $body['mode'] ?? 'zip',
                'source'      => $body['source'] ?? '',
                'destination' => $body['destination'] ?? '',
            ], 65);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.archive', (string) ($body['source'] ?? ''));
            vanillia_json_success($res);

        case 'upload':
            $user = vanillia_require_admin();
            $targetDir = rtrim(trim((string) ($_POST['dir'] ?? '/tmp')), '/');
            if ($targetDir === '') {
                $targetDir = '/';
            }
            if (empty($_FILES['files'])) {
                vanillia_json_error('NO_FILES', 'Aucun fichier reçu.');
            }

            $files = $_FILES['files'];
            $names = is_array($files['name']) ? $files['name'] : [$files['name']];
            $tmpNames = is_array($files['tmp_name']) ? $files['tmp_name'] : [$files['tmp_name']];
            $errors = is_array($files['error']) ? $files['error'] : [$files['error']];
            $uploaded = [];

            foreach ($names as $idx => $origName) {
                if (($errors[$idx] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                    continue;
                }
                $safeName = basename((string) $origName);
                if ($safeName === '' || $safeName === '.' || $safeName === '..') {
                    continue;
                }
                $destPath = ($targetDir === '/' ? '' : $targetDir) . '/' . $safeName;
                $tmpFile = (string) $tmpNames[$idx];

                if (is_dir($targetDir) && is_writable($targetDir) && @move_uploaded_file($tmpFile, $destPath)) {
                    $uploaded[] = $destPath;
                } elseif ($agent->isAvailable() && is_readable($tmpFile)) {
                    $raw = (string) file_get_contents($tmpFile);
                    $agent->call('fs.write', [
                        'path'    => $destPath,
                        'content' => base64_encode($raw),
                        'base64'  => true,
                    ], 30);
                    $uploaded[] = $destPath;
                }
            }

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'fs.upload', $targetDir, ['count' => count($uploaded)]);
            vanillia_json_success(['uploaded' => $uploaded]);

        case 'download':
        case 'preview':
            $user = vanillia_require_admin();
            $path = trim((string) ($_GET['path'] ?? ''));
            $inline = $action === 'preview';

            $mimeMap = [
                'png'  => 'image/png',
                'jpg'  => 'image/jpeg',
                'jpeg' => 'image/jpeg',
                'gif'  => 'image/gif',
                'webp' => 'image/webp',
                'svg'  => 'image/svg+xml',
                'pdf'  => 'application/pdf',
                'mp4'  => 'video/mp4',
                'webm' => 'video/webm',
                'mp3'  => 'audio/mpeg',
                'wav'  => 'audio/wav',
                'ogg'  => 'audio/ogg',
                'txt'  => 'text/plain; charset=utf-8',
                'json' => 'application/json; charset=utf-8',
            ];
            $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
            $mime = $mimeMap[$ext] ?? 'application/octet-stream';
            $filename = rawurlencode(basename($path));
            $disp = $inline ? 'inline' : 'attachment';

            if (is_file($path) && is_readable($path)) {
                header('Content-Type: ' . $mime);
                header('Content-Length: ' . (string) filesize($path));
                header("Content-Disposition: {$disp}; filename*=UTF-8''{$filename}");
                header('X-Content-Type-Options: nosniff');
                readfile($path);
                exit;
            }

            if ($agent->isAvailable()) {
                $res = $agent->call('fs.read', [
                    'path'      => $path,
                    'max_bytes' => 1_572_864,
                    'base64'    => true,
                ], 20);
                $bin = (string) base64_decode((string) ($res['content'] ?? ''), true);
                header('Content-Type: ' . $mime);
                header('Content-Length: ' . (string) strlen($bin));
                header("Content-Disposition: {$disp}; filename*=UTF-8''{$filename}");
                header('X-Content-Type-Options: nosniff');
                echo $bin;
                exit;
            }

            vanillia_json_error('FILE_UNREADABLE', 'Fichier introuvable ou inaccessible.', 404);

        // ======================================================================
        // 2. NOTES MARKDOWN (.md EN CLAIR DANS /var/lib/vanill-ia-os/notes/)
        // ======================================================================
        case 'notes_list':
            $user = vanillia_require_auth();
            $dir = vanillia_notes_dir();
            $files = glob($dir . '/*.md') ?: [];
            $notes = [];

            foreach ($files as $f) {
                $slug = basename($f, '.md');
                $notes[] = [
                    'name'       => $slug,
                    'filename'   => basename($f),
                    'size'       => (int) filesize($f),
                    'updated_at' => gmdate('Y-m-d H:i:s', (int) filemtime($f)),
                ];
            }
            usort($notes, static fn (array $a, array $b): int => strcmp($b['updated_at'], $a['updated_at']));
            vanillia_json_success(['notes' => $notes, 'storage_dir' => $dir]);

        case 'note_get':
            $user = vanillia_require_auth();
            $name = preg_replace('/[^a-zA-Z0-9 _.-]/u', '', trim((string) ($_GET['name'] ?? ''))) ?? '';
            $file = vanillia_notes_dir() . '/' . $name . '.md';
            if ($name === '' || !is_file($file)) {
                vanillia_json_error('NOTE_NOT_FOUND', 'Note introuvable.', 404);
            }
            vanillia_json_success([
                'name'    => $name,
                'content' => (string) file_get_contents($file),
            ]);

        case 'note_save':
            $user = vanillia_require_auth();
            $body = vanillia_read_body();
            $name = preg_replace('/[^a-zA-Z0-9 _.-]/u', '', trim((string) ($body['name'] ?? ''))) ?? '';
            $oldName = preg_replace('/[^a-zA-Z0-9 _.-]/u', '', trim((string) ($body['old_name'] ?? ''))) ?? '';
            $content = (string) ($body['content'] ?? '');

            if ($name === '' || strlen($name) > 80) {
                vanillia_json_error('INVALID_NOTE_NAME', 'Nom de note invalide.');
            }

            $dir = vanillia_notes_dir();
            if ($oldName !== '' && $oldName !== $name && is_file("{$dir}/{$oldName}.md")) {
                @unlink("{$dir}/{$oldName}.md");
            }
            file_put_contents("{$dir}/{$name}.md", str_replace("\r\n", "\n", $content));

            vanillia_json_success(['saved' => true, 'name' => $name]);

        case 'note_delete':
            $user = vanillia_require_auth();
            $body = vanillia_read_body();
            $name = preg_replace('/[^a-zA-Z0-9 _.-]/u', '', trim((string) ($body['name'] ?? ''))) ?? '';
            $file = vanillia_notes_dir() . '/' . $name . '.md';
            if (is_file($file)) {
                @unlink($file);
            }
            vanillia_json_success(['deleted' => true]);

        default:
            vanillia_json_error('UNKNOWN_FILES_ACTION', "Action fichiers inconnue : {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
