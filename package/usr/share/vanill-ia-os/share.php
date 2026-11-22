<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Autonomous Public File Share Download Page (/share.php)
 * Accessible without a Vanill-IA OS user account via `?t=<token>`.
 * - Optional password verification (`password_verify` + anti-bruteforce)
 * - Expiration & max-download atomic enforcement (`404` / `410 Gone`)
 * - 8 KB chunked streaming (`fread` loop) for large files with zero RAM bloat
 * ==============================================================================
 */

require_once __DIR__ . '/api/bootstrap.php';

vanillia_start_session(false);

$pdo = vanillia_db();
$agent = new AgentClient();
$token = trim((string) ($_GET['t'] ?? ''));

// Bilingual EN (default) / FR detection + ?lang= override
$reqLang = strtolower(trim((string) ($_GET['lang'] ?? '')));
if (in_array($reqLang, ['en', 'fr'], true)) {
    $_SESSION['share_ui_lang'] = $reqLang;
}
$acceptLang = strtolower((string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
$lang = $_SESSION['share_ui_lang'] ?? (str_starts_with($acceptLang, 'fr') ? 'fr' : 'en');

$L = $lang === 'fr' ? [
    'title_share'    => 'Fichier partagé — Vanill-IA OS',
    'title_err'      => 'Lien indisponible — Vanill-IA OS',
    'shared_badge'   => 'Partage sécurisé Vanill-IA OS',
    'size'           => 'Taille',
    'expires'        => 'Expire le',
    'unlimited'      => 'Sans limite',
    'remaining_dl'   => 'Téléchargements restants',
    'password_req'   => 'Ce fichier est protégé par un mot de passe.',
    'password_ph'    => 'Saisissez le mot de passe...',
    'wrong_password' => 'Mot de passe incorrect.',
    'unlock_btn'     => 'Déverrouiller et Télécharger',
    'download_btn'   => '⬇️ Télécharger le fichier',
    'not_found_h'    => 'Lien de partage introuvable (404)',
    'not_found_p'    => 'Ce lien est invalide ou a été révoqué par son propriétaire.',
    'gone_h'         => 'Lien expiré ou épuisé (410)',
    'gone_p'         => 'La date de validité ou le nombre maximal de téléchargements de ce fichier a été atteint.',
] : [
    'title_share'    => 'Shared File — Vanill-IA OS',
    'title_err'      => 'Link Unavailable — Vanill-IA OS',
    'shared_badge'   => 'Vanill-IA OS Secure File Share',
    'size'           => 'Size',
    'expires'        => 'Expires',
    'unlimited'      => 'Never',
    'remaining_dl'   => 'Remaining downloads',
    'password_req'   => 'This shared file is protected by a password.',
    'password_ph'    => 'Enter share password...',
    'wrong_password' => 'Incorrect password.',
    'unlock_btn'     => 'Unlock & Download',
    'download_btn'   => '⬇️ Download File',
    'not_found_h'    => 'Share Link Not Found (404)',
    'not_found_p'    => 'This share link is invalid or was revoked by its owner.',
    'gone_h'         => 'Share Link Expired (410)',
    'gone_p'         => 'This link has expired, reached its download limit, or the source file was removed.',
];

function format_share_bytes(int $bytes): string
{
    if ($bytes <= 0) {
        return '0 B';
    }
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $i = (int) min(count($units) - 1, floor(log($bytes, 1024)));
    return round($bytes / (1024 ** $i), $i >= 3 ? 2 : 1) . ' ' . $units[$i];
}

// 1. Lookup share token
$share = false;
if ($token !== '' && preg_match('/^[a-f0-9]{32,64}$/', $token) === 1) {
    $stmt = $pdo->prepare('SELECT * FROM file_shares WHERE token = :t LIMIT 1');
    $stmt->execute([':t' => $token]);
    $share = $stmt->fetch();
}

$httpError = 0;
$now = time();

if ($share === false) {
    $httpError = 404;
} else {
    $expiresAt = $share['expires_at'] !== null ? (int) $share['expires_at'] : null;
    $maxDl = $share['max_downloads'] !== null ? (int) $share['max_downloads'] : null;
    $dlCount = (int) $share['download_count'];

    if (($expiresAt !== null && $expiresAt <= $now) || ($maxDl !== null && $dlCount >= $maxDl)) {
        $httpError = 410;
    } else {
        // Verify source file still exists (directly or via privileged stat)
        $filePath = (string) $share['file_path'];
        $exists = is_file($filePath);
        if (!$exists && $agent->isAvailable()) {
            try {
                $stat = $agent->call('fs.stat_share', ['path' => $filePath], 6);
                $exists = !empty($stat['real_path']);
            } catch (Throwable) {
                $exists = false;
            }
        }
        if (!$exists) {
            $httpError = 410;
        }
    }
}

$passwordError = '';
$needsPassword = $httpError === 0 && !empty($share['password_hash']);
$isUnlocked = !$needsPassword || !empty($_SESSION['unlocked_shares'][$token]);

// 2. Handle Password Unlock or Download Trigger
if ($httpError === 0 && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $clientIp = vanillia_client_ip();
    $submittedPass = (string) ($_POST['share_password'] ?? '');
    $postedCsrf = (string) ($_POST['_csrf'] ?? '');

    if (!hash_equals(vanillia_csrf_token(), $postedCsrf)) {
        $passwordError = 'Invalid security token. Please reload.';
    } elseif ($needsPassword && !$isUnlocked) {
        // Check SQLite rate limiter before verifying password
        $rlStmt = $pdo->prepare('SELECT locked_until FROM auth_attempts WHERE ip_address = :ip LIMIT 1');
        $rlStmt->execute([':ip' => $clientIp]);
        $lockedUntil = (int) ($rlStmt->fetchColumn() ?: 0);

        if ($lockedUntil > $now) {
            $passwordError = 'Too many failed attempts. Please wait a few minutes.';
        } elseif ($submittedPass !== '' && password_verify($submittedPass, (string) $share['password_hash'])) {
            vanillia_clear_auth_failures($clientIp);
            $_SESSION['unlocked_shares'][$token] = true;
            $isUnlocked = true;
        } else {
            vanillia_record_auth_failure($clientIp, 'share:' . substr($token, 0, 8), 'invalid_share_password');
            $passwordError = $L['wrong_password'];
        }
    }

    // Stream file if unlocked and download requested
    if ($isUnlocked && $passwordError === '' && isset($_POST['download_now'])) {
        // Atomic increment + limit verification
        $upd = $pdo->prepare(
            'UPDATE file_shares
             SET download_count = download_count + 1
             WHERE id = :id
               AND (expires_at IS NULL OR expires_at > :now)
               AND (max_downloads IS NULL OR download_count < max_downloads)'
        );
        $upd->execute([':id' => (int) $share['id'], ':now' => time()]);

        if ($upd->rowCount() !== 1) {
            $httpError = 410;
        } else {
            session_write_close();
            while (ob_get_level() > 0) {
                @ob_end_clean();
            }
            @set_time_limit(0);

            $filePath = (string) $share['file_path'];
            $fileName = (string) $share['file_name'];
            $safeFilename = rawurlencode($fileName);
            $asciiFallback = preg_replace('/[^a-zA-Z0-9._-]/', '_', $fileName) ?: 'download';

            $fileSize = is_file($filePath) ? (int) filesize($filePath) : (int) $share['file_size'];

            header('Content-Type: application/octet-stream');
            header("Content-Disposition: attachment; filename=\"{$asciiFallback}\"; filename*=UTF-8''{$safeFilename}");
            if ($fileSize > 0) {
                header('Content-Length: ' . (string) $fileSize);
            }
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: private, no-transform, no-store, must-revalidate');

            // Direct 8 KB chunked file stream when readable by www-data
            if (is_file($filePath) && is_readable($filePath)) {
                $fp = fopen($filePath, 'rb');
                if ($fp !== false) {
                    while (!feof($fp) && !connection_aborted()) {
                        $buf = fread($fp, 8192);
                        if ($buf === false || $buf === '') {
                            break;
                        }
                        echo $buf;
                        flush();
                    }
                    fclose($fp);
                    exit;
                }
            }

            // Fallback chunked stream via vanill-ia-agent for root-owned paths (256 KB IPC -> 8 KB output)
            if ($agent->isAvailable()) {
                $offset = 0;
                while (!connection_aborted()) {
                    $chunkRes = $agent->call('fs.read_chunk', [
                        'path'   => $filePath,
                        'offset' => $offset,
                        'length' => 262144,
                    ], 30);
                    $rawChunk = base64_decode((string) ($chunkRes['chunk_b64'] ?? ''), true);
                    if ($rawChunk === false || $rawChunk === '') {
                        break;
                    }
                    $len = strlen($rawChunk);
                    for ($p = 0; $p < $len; $p += 8192) {
                        echo substr($rawChunk, $p, 8192);
                        flush();
                    }
                    $offset += $len;
                    if (!empty($chunkRes['eof'])) {
                        break;
                    }
                }
                exit;
            }

            exit;
        }
    }
}

if ($httpError > 0) {
    http_response_code($httpError);
}

$fileSizeDisplay = $httpError === 0
    ? format_share_bytes(is_file((string) $share['file_path']) ? (int) filesize((string) $share['file_path']) : (int) ($share['file_size'] ?? 0))
    : '';
$expiresDisplay = ($httpError === 0 && $share['expires_at'] !== null)
    ? gmdate('Y-m-d H:i \U\T\C', (int) $share['expires_at'])
    : $L['unlimited'];
$remainingDisplay = ($httpError === 0 && $share['max_downloads'] !== null)
    ? (string) max(0, ((int) $share['max_downloads']) - ((int) $share['download_count']))
    : '∞';
?>
<!DOCTYPE html>
<html lang="<?= htmlspecialchars($lang, ENT_QUOTES, 'UTF-8') ?>" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <title><?= htmlspecialchars($httpError === 0 ? $L['title_share'] : $L['title_err'], ENT_QUOTES, 'UTF-8') ?></title>
  <link rel="icon" type="image/svg+xml" href="/assets/img/icons/logo.svg">
  <link rel="stylesheet" href="/assets/css/desktop.css">
  <style>
    body { overflow-y: auto; user-select: text; -webkit-user-select: text; }
    .share-stage {
      position: relative;
      z-index: 10;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 18px;
    }
    .lang-pill {
      position: fixed;
      top: 16px;
      right: 18px;
      z-index: 20;
      display: inline-flex;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--os-surface);
      border: 1px solid var(--os-border-strong);
      backdrop-filter: var(--os-blur);
      font-size: 0.76rem;
    }
    .lang-pill a {
      color: var(--os-text-secondary);
      text-decoration: none;
      font-weight: 600;
    }
    .lang-pill a.active { color: var(--os-accent); }
    .file-meta-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin: 18px 0 22px;
    }
    .file-meta-item {
      padding: 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid var(--os-border);
      text-align: center;
    }
    .file-meta-item .lbl { font-size: 0.7rem; color: var(--os-text-secondary); margin-bottom: 3px; }
    .file-meta-item .val { font-family: var(--font-mono); font-size: 0.8rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="os-wallpaper" aria-hidden="true"></div>

  <nav class="lang-pill" aria-label="Language">
    <a href="?t=<?= urlencode($token) ?>&amp;lang=en" class="<?= $lang === 'en' ? 'active' : '' ?>">EN</a>
    <span style="opacity:0.35;">|</span>
    <a href="?t=<?= urlencode($token) ?>&amp;lang=fr" class="<?= $lang === 'fr' ? 'active' : '' ?>">FR</a>
  </nav>

  <main class="share-stage">
    <div class="auth-card" style="max-width:460px;">
      <div class="brand-header" style="margin-bottom:18px;">
        <img src="/assets/img/icons/logo.svg" alt="Vanill-IA OS" class="brand-logo">
        <?php if ($httpError === 0): ?>
          <span class="status-pill-sm status-info" style="margin-bottom:10px;"><?= htmlspecialchars($L['shared_badge'], ENT_QUOTES, 'UTF-8') ?></span>
          <h1 style="word-break:break-all;font-size:1.22rem;"><?= htmlspecialchars((string) $share['file_name'], ENT_QUOTES, 'UTF-8') ?></h1>
        <?php else: ?>
          <h1><?= htmlspecialchars($httpError === 404 ? $L['not_found_h'] : $L['gone_h'], ENT_QUOTES, 'UTF-8') ?></h1>
          <p style="margin-top:8px;"><?= htmlspecialchars($httpError === 404 ? $L['not_found_p'] : $L['gone_p'], ENT_QUOTES, 'UTF-8') ?></p>
        <?php endif; ?>
      </div>

      <?php if ($httpError === 0): ?>
        <div class="file-meta-grid">
          <div class="file-meta-item">
            <div class="lbl"><?= htmlspecialchars($L['size'], ENT_QUOTES, 'UTF-8') ?></div>
            <div class="val"><?= htmlspecialchars($fileSizeDisplay, ENT_QUOTES, 'UTF-8') ?></div>
          </div>
          <div class="file-meta-item">
            <div class="lbl"><?= htmlspecialchars($L['expires'], ENT_QUOTES, 'UTF-8') ?></div>
            <div class="val"><?= htmlspecialchars($expiresDisplay, ENT_QUOTES, 'UTF-8') ?></div>
          </div>
          <div class="file-meta-item">
            <div class="lbl"><?= htmlspecialchars($L['remaining_dl'], ENT_QUOTES, 'UTF-8') ?></div>
            <div class="val"><?= htmlspecialchars($remainingDisplay, ENT_QUOTES, 'UTF-8') ?></div>
          </div>
        </div>

        <?php if ($passwordError !== ''): ?>
          <div class="os-alert os-alert-error"><?= htmlspecialchars($passwordError, ENT_QUOTES, 'UTF-8') ?></div>
        <?php endif; ?>

        <form method="post" action="?t=<?= urlencode($token) ?>">
          <input type="hidden" name="_csrf" value="<?= htmlspecialchars(vanillia_csrf_token(), ENT_QUOTES, 'UTF-8') ?>">
          <input type="hidden" name="download_now" value="1">

          <?php if ($needsPassword && !$isUnlocked): ?>
            <div class="os-alert os-alert-info"><?= htmlspecialchars($L['password_req'], ENT_QUOTES, 'UTF-8') ?></div>
            <div class="form-group">
              <input type="password" name="share_password" class="os-input" placeholder="<?= htmlspecialchars($L['password_ph'], ENT_QUOTES, 'UTF-8') ?>" required autofocus>
            </div>
            <button type="submit" class="os-btn os-btn-primary">🔓 <?= htmlspecialchars($L['unlock_btn'], ENT_QUOTES, 'UTF-8') ?></button>
          <?php else: ?>
            <button type="submit" class="os-btn os-btn-primary"><?= htmlspecialchars($L['download_btn'], ENT_QUOTES, 'UTF-8') ?></button>
          <?php endif; ?>
        </form>
      <?php endif; ?>
    </div>
  </main>
</body>
</html>
