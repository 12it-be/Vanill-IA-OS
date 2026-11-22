<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Authentication, First-Boot Setup Wizard, Session Lock & 2FA API
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'status'));
$pdo = vanillia_db();
$clientIp = vanillia_client_ip();

/**
 * Formate le profil utilisateur sans exposer le hash de mot de passe ni le secret TOTP.
 *
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function format_public_user(array $row): array
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
        'last_login_at'        => $row['last_login_at'] ?? null,
    ];
}

/**
 * Vérifie un code 2FA (TOTP 6 chiffres OU code de secours XXXX-XXXX à usage unique).
 *
 * @param array<string, mixed> $userRow
 */
function verify_user_2fa(PDO $pdo, array $userRow, string $code): bool
{
    $secret = vanillia_decrypt((string) ($userRow['totp_secret'] ?? ''));
    if ($secret !== '' && Totp::verify($secret, $code)) {
        return true;
    }

    // Vérification des codes de secours hachés
    $normalized = strtoupper(trim($code));
    $hashes = json_decode((string) ($userRow['totp_backup_codes_json'] ?? '[]'), true);
    if (is_array($hashes) && $hashes !== []) {
        foreach ($hashes as $idx => $hash) {
            if (is_string($hash) && password_verify($normalized, $hash)) {
                unset($hashes[$idx]);
                $upd = $pdo->prepare('UPDATE users SET totp_backup_codes_json = :bc WHERE id = :id');
                $upd->execute([
                    ':bc' => json_encode(array_values($hashes)),
                    ':id' => (int) $userRow['id'],
                ]);
                return true;
            }
        }
    }

    return false;
}

switch ($action) {
    // --------------------------------------------------------------------------
    // Healthcheck ultra-léger utilisé par offline.html pendant un reboot serveur
    // --------------------------------------------------------------------------
    case 'ping':
        vanillia_json_success([
            'online'    => true,
            'version'   => VANILLIA_VERSION,
            'timestamp' => time(),
        ]);

    // --------------------------------------------------------------------------
    // Initial session status, Setup Wizard state or active Session Lock
    // --------------------------------------------------------------------------
    case 'status':
        vanillia_start_session(false);
        $usersCount = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
        $setupRequired = $usersCount === 0;

        $isLanOrTailscale = vanillia_is_lan_or_tailscale_ip($clientIp);
        $tokenHash = vanillia_get_setting('security.setup_token_hash', '');
        $requireTokenOnLan = vanillia_get_setting('security.require_token_on_lan', '0') === '1';
        $requiresSetupToken = $setupRequired && $tokenHash !== '' && (!$isLanOrTailscale || $requireTokenOnLan);

        $userPayload = null;
        $authenticated = false;
        $locked = false;

        if (!$setupRequired && !empty($_SESSION['user_id'])) {
            $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
            $stmt->execute([':id' => (int) $_SESSION['user_id']]);
            $row = $stmt->fetch();
            if ($row !== false) {
                $authenticated = true;
                $locked = !empty($_SESSION['locked']);
                $userPayload = format_public_user($row);
            } else {
                session_unset();
            }
        }

        vanillia_json_success([
            'setup_required'       => $setupRequired,
            'requires_setup_token' => $requiresSetupToken,
            'is_local_network'     => $isLanOrTailscale,
            'client_ip'            => $clientIp,
            'authenticated'        => $authenticated,
            'locked'               => $locked,
            'csrf_token'           => vanillia_csrf_token(),
            'user'                 => $userPayload,
            'os'                   => [
                'name'               => vanillia_get_setting('os.name', 'Vanill-IA OS'),
                'hostname'           => gethostname() ?: 'debian',
                'version'            => VANILLIA_VERSION,
                'metrics_interval'   => (int) vanillia_get_setting('os.metrics_interval_ms', '3000'),
                'network_exposure'   => vanillia_get_setting('security.network_exposure', 'all'),
            ],
        ]);

    // --------------------------------------------------------------------------
    // Préparation optionnelle d'un secret TOTP pendant le Setup Wizard
    // --------------------------------------------------------------------------
    case 'setup_prepare_totp':
        vanillia_verify_csrf();
        if ((int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
            vanillia_json_error('SETUP_LOCKED', 'L\'assistant d\'initialisation est définitivement verrouillé.', 403);
        }

        $body = vanillia_read_body();
        $username = trim((string) ($body['username'] ?? 'admin')) ?: 'admin';
        $secret = Totp::generateSecret();
        $_SESSION['pending_setup_totp_secret'] = $secret;

        vanillia_json_success([
            'secret'      => $secret,
            'otpauth_uri' => Totp::buildOtpAuthUri($username, $secret, 'Vanill-IA OS'),
        ]);

    // --------------------------------------------------------------------------
    // Création du compte Administrateur unique (Premier Lancement sécurisé)
    // --------------------------------------------------------------------------
    case 'setup':
        vanillia_verify_csrf();
        vanillia_check_rate_limit($clientIp);

        $pdo->beginTransaction();
        try {
            $usersCount = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
            if ($usersCount > 0) {
                $pdo->rollBack();
                vanillia_json_error('SETUP_LOCKED', 'Le compte administrateur existe déjà. Route verrouillée.', 403);
            }

            $body = vanillia_read_body();
            $username = trim((string) ($body['username'] ?? ''));
            $displayName = trim((string) ($body['display_name'] ?? 'Administrator')) ?: 'Administrator';
            $language = in_array($body['language'] ?? 'en', ['en', 'fr'], true) ? (string) $body['language'] : 'en';
            $password = (string) ($body['password'] ?? '');
            $setupToken = strtoupper(trim((string) ($body['setup_token'] ?? '')));
            $enableTotp = !empty($body['enable_totp']);
            $totpCode = trim((string) ($body['totp_code'] ?? ''));

            // Validation du Setup Token si requis (accès WAN/VPS ou si un token est saisi)
            $tokenHash = vanillia_get_setting('security.setup_token_hash', '');
            $isLan = vanillia_is_lan_or_tailscale_ip($clientIp);
            $requireOnLan = vanillia_get_setting('security.require_token_on_lan', '0') === '1';

            if ($tokenHash !== '' && (!$isLan || $requireOnLan || $setupToken !== '')) {
                if ($setupToken === '' || !password_verify($setupToken, $tokenHash)) {
                    $pdo->rollBack();
                    vanillia_record_auth_failure($clientIp, $username ?: 'setup', 'invalid_setup_token');
                    vanillia_json_error('INVALID_SETUP_TOKEN', 'Jeton d\'initialisation invalide. Récupérez-le via : sudo vanill-ia-os setup-token', 403);
                }
            }

            if (preg_match('/^[a-zA-Z0-9_.-]{3,32}$/', $username) !== 1) {
                $pdo->rollBack();
                vanillia_json_error('INVALID_USERNAME', 'L\'identifiant doit contenir entre 3 et 32 caractères (lettres, chiffres, tirets, points).');
            }

            if (strlen($password) < 10) {
                $pdo->rollBack();
                vanillia_json_error('WEAK_PASSWORD', 'Le mot de passe administrateur doit comporter au moins 10 caractères.');
            }

            $encryptedTotp = null;
            $backupCodesPlain = [];
            $backupCodesHashed = [];

            if ($enableTotp) {
                $pendingSecret = (string) ($_SESSION['pending_setup_totp_secret'] ?? '');
                if ($pendingSecret === '' || !Totp::verify($pendingSecret, $totpCode)) {
                    $pdo->rollBack();
                    vanillia_json_error('INVALID_TOTP_CODE', 'Le code 2FA à 6 chiffres est incorrect. Vérifiez l\'heure de votre téléphone.');
                }
                $encryptedTotp = vanillia_encrypt($pendingSecret);
                $backupCodesPlain = Totp::generateBackupCodes(8);
                $backupCodesHashed = array_map(static fn (string $c): string => password_hash($c, PASSWORD_ARGON2ID), $backupCodesPlain);
            }

            $passwordHash = password_hash($password, PASSWORD_ARGON2ID);
            $now = gmdate('Y-m-d H:i:s');

            $ins = $pdo->prepare(
                'INSERT INTO users (username, password_hash, display_name, role, must_change_password, totp_enabled, totp_secret, totp_backup_codes_json, language, last_login_at, last_login_ip, created_at, updated_at)
                 VALUES (:u, :ph, :dn, "admin", 0, :te, :ts, :bc, :lang, :ll, :ip, :c, :u_at)'
            );
            $ins->execute([
                ':u'    => $username,
                ':ph'   => $passwordHash,
                ':dn'   => substr($displayName, 0, 64),
                ':te'   => $enableTotp ? 1 : 0,
                ':ts'   => $encryptedTotp,
                ':bc'   => json_encode($backupCodesHashed),
                ':lang' => $language,
                ':ll'   => $now,
                ':ip'   => $clientIp,
                ':c'    => $now,
                ':u_at' => $now,
            ]);
            $newUserId = (int) $pdo->lastInsertId();

            // Verrouillage définitif du Setup Wizard
            vanillia_set_setting('security.setup_completed', '1', 'security');
            vanillia_set_setting('security.setup_token_hash', '', 'security');

            $notif = $pdo->prepare(
                'INSERT INTO notifications (level, source, title, message, created_at)
                 VALUES ("success", "security", "Bienvenue sur Vanill-IA OS", :msg, :ts)'
            );
            $notif->execute([
                ':msg' => sprintf('Compte administrateur "%s" initialisé avec protection Argon2id%s.', $username, $enableTotp ? ' + 2FA TOTP actif' : ''),
                ':ts'  => $now,
            ]);

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            vanillia_json_error('SETUP_ERROR', 'Erreur lors de l\'initialisation : ' . $e->getMessage(), 500);
        }

        unset($_SESSION['pending_setup_totp_secret']);
        @unlink(vanillia_data_dir() . '/setup.token');
        vanillia_clear_auth_failures($clientIp);

        session_regenerate_id(true);
        $_SESSION['user_id'] = $newUserId;
        $_SESSION['locked'] = false;
        $_SESSION['session_lock_minutes'] = 15;
        $_SESSION['last_activity_at'] = time();
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));

        $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $newUserId]);
        $userRow = $stmt->fetch() ?: [];

        vanillia_audit_log($newUserId, (string) $userRow['username'], 'auth.setup_completed', null, ['totp' => !empty($userRow['totp_enabled'])]);

        vanillia_json_success([
            'csrf_token'   => $_SESSION['csrf_token'],
            'user'         => format_public_user($userRow),
            'backup_codes' => $backupCodesPlain,
        ]);

    // --------------------------------------------------------------------------
    // Connexion (Argon2id + 2FA TOTP / Code de secours + Anti-Bruteforce)
    // --------------------------------------------------------------------------
    case 'login':
        vanillia_verify_csrf();
        vanillia_check_rate_limit($clientIp);

        $body = vanillia_read_body();
        $username = trim((string) ($body['username'] ?? ''));
        $password = (string) ($body['password'] ?? '');
        $totpCode = trim((string) ($body['totp_code'] ?? ''));

        if ($username === '' || $password === '') {
            vanillia_json_error('MISSING_CREDENTIALS', 'Veuillez renseigner votre identifiant et votre mot de passe.');
        }

        $stmt = $pdo->prepare('SELECT * FROM users WHERE username = :u LIMIT 1');
        $stmt->execute([':u' => $username]);
        $user = $stmt->fetch();

        // Temps constant même si l'utilisateur n'existe pas
        $dummyHash = '$argon2id$v=19$m=65536,t=4,p=1$V2FuaWxsSUFPUw$6zR3K9pL5M8nQ2vX7yB1wC4dE6fG8hJ0kM2nP4qR6sT';
        $hashToVerify = $user !== false ? (string) $user['password_hash'] : $dummyHash;
        $passwordOk = password_verify($password, $hashToVerify);

        if ($user === false || !$passwordOk) {
            vanillia_record_auth_failure($clientIp, $username, 'invalid_password');
            vanillia_json_error('INVALID_CREDENTIALS', 'Identifiant ou mot de passe incorrect.', 401);
        }

        // Vérification 2FA TOTP si activé sur le compte
        if (((int) $user['totp_enabled']) === 1) {
            if ($totpCode === '') {
                vanillia_json_success([
                    'totp_required' => true,
                    'username'      => (string) $user['username'],
                ]);
            }

            if (!verify_user_2fa($pdo, $user, $totpCode)) {
                vanillia_record_auth_failure($clientIp, $username, 'invalid_2fa_code');
                vanillia_json_error('INVALID_TOTP', 'Code d\'authentification 2FA invalide.', 401);
            }
        }

        vanillia_clear_auth_failures($clientIp);
        session_regenerate_id(true);

        $now = gmdate('Y-m-d H:i:s');
        $pdo->prepare('UPDATE users SET last_login_at = :ll, last_login_ip = :ip WHERE id = :id')->execute([
            ':ll' => $now,
            ':ip' => $clientIp,
            ':id' => (int) $user['id'],
        ]);

        $_SESSION['user_id'] = (int) $user['id'];
        $_SESSION['locked'] = false;
        $_SESSION['session_lock_minutes'] = (int) ($user['session_lock_minutes'] ?? 15);
        $_SESSION['last_activity_at'] = time();
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));

        vanillia_audit_log((int) $user['id'], (string) $user['username'], 'auth.login', null);

        $user['last_login_at'] = $now;
        vanillia_json_success([
            'totp_required' => false,
            'csrf_token'    => $_SESSION['csrf_token'],
            'user'          => format_public_user($user),
        ]);

    // --------------------------------------------------------------------------
    // Explicit session lock (preserves open desktop workspace)
    // --------------------------------------------------------------------------
    case 'lock':
        $user = vanillia_require_auth(true);
        $_SESSION['locked'] = true;
        vanillia_json_success(['locked' => true]);

    // --------------------------------------------------------------------------
    // Unlock active locked session
    // --------------------------------------------------------------------------
    case 'unlock':
        $user = vanillia_require_auth(true, false);
        vanillia_check_rate_limit($clientIp);

        $body = vanillia_read_body();
        $password = (string) ($body['password'] ?? '');
        $totpCode = trim((string) ($body['totp_code'] ?? ''));

        if ($password === '' || !password_verify($password, (string) $user['password_hash'])) {
            vanillia_record_auth_failure($clientIp, (string) $user['username'], 'unlock_invalid_password');
            vanillia_json_error('INVALID_PASSWORD', 'Mot de passe incorrect.', 401);
        }

        if (((int) $user['totp_enabled']) === 1) {
            if ($totpCode === '' || !verify_user_2fa($pdo, $user, $totpCode)) {
                vanillia_record_auth_failure($clientIp, (string) $user['username'], 'unlock_invalid_2fa');
                vanillia_json_error('INVALID_TOTP', 'Code 2FA requis ou incorrect.', 401);
            }
        }

        vanillia_clear_auth_failures($clientIp);
        $_SESSION['locked'] = false;
        $_SESSION['last_activity_at'] = time();

        vanillia_json_success([
            'locked' => false,
            'user'   => format_public_user($user),
        ]);

    // --------------------------------------------------------------------------
    // Déconnexion complète
    // --------------------------------------------------------------------------
    case 'logout':
        vanillia_start_session(false);
        vanillia_verify_csrf();

        $uid = isset($_SESSION['user_id']) ? (int) $_SESSION['user_id'] : null;
        if ($uid !== null) {
            vanillia_audit_log($uid, 'user', 'auth.logout');
        }

        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
        }
        session_destroy();

        vanillia_json_success(['logged_out' => true]);

    // --------------------------------------------------------------------------
    // Gestion du 2FA TOTP depuis le Bureau (Préparer / Activer / Désactiver)
    // --------------------------------------------------------------------------
    case 'totp_prepare':
        $user = vanillia_require_auth();
        $secret = Totp::generateSecret();
        $_SESSION['pending_totp_secret'] = $secret;

        vanillia_json_success([
            'secret'      => $secret,
            'otpauth_uri' => Totp::buildOtpAuthUri((string) $user['username'], $secret, 'Vanill-IA OS'),
        ]);

    case 'totp_enable':
        $user = vanillia_require_auth();
        $body = vanillia_read_body();
        $password = (string) ($body['password'] ?? '');
        $code = trim((string) ($body['totp_code'] ?? ''));
        $secret = (string) ($_SESSION['pending_totp_secret'] ?? '');

        if (!password_verify($password, (string) $user['password_hash'])) {
            vanillia_json_error('INVALID_PASSWORD', 'Mot de passe actuel incorrect.', 401);
        }
        if ($secret === '' || !Totp::verify($secret, $code)) {
            vanillia_json_error('INVALID_TOTP_CODE', 'Le code TOTP à 6 chiffres est invalide.');
        }

        $backupPlain = Totp::generateBackupCodes(8);
        $backupHashed = array_map(static fn (string $c): string => password_hash($c, PASSWORD_ARGON2ID), $backupPlain);

        $upd = $pdo->prepare('UPDATE users SET totp_enabled = 1, totp_secret = :ts, totp_backup_codes_json = :bc, updated_at = :u WHERE id = :id');
        $upd->execute([
            ':ts' => vanillia_encrypt($secret),
            ':bc' => json_encode($backupHashed),
            ':u'  => gmdate('Y-m-d H:i:s'),
            ':id' => (int) $user['id'],
        ]);

        unset($_SESSION['pending_totp_secret']);
        vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.totp_enabled');

        vanillia_json_success([
            'totp_enabled' => true,
            'backup_codes' => $backupPlain,
        ]);

    case 'totp_disable':
        $user = vanillia_require_auth();
        $body = vanillia_read_body();
        $password = (string) ($body['password'] ?? '');
        $code = trim((string) ($body['totp_code'] ?? ''));

        if (!password_verify($password, (string) $user['password_hash'])) {
            vanillia_json_error('INVALID_PASSWORD', 'Mot de passe actuel incorrect.', 401);
        }
        if (!verify_user_2fa($pdo, $user, $code)) {
            vanillia_json_error('INVALID_TOTP_CODE', 'Code 2FA ou code de secours invalide.', 401);
        }

        $pdo->prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes_json = "[]", updated_at = :u WHERE id = :id')
            ->execute([':u' => gmdate('Y-m-d H:i:s'), ':id' => (int) $user['id']]);

        vanillia_audit_log((int) $user['id'], (string) $user['username'], 'security.totp_disabled');
        vanillia_json_success(['totp_enabled' => false]);

    // --------------------------------------------------------------------------
    // Sauvegarde temps réel des préférences visuelles & sécurité du Bureau
    // --------------------------------------------------------------------------
    case 'preferences':
        $user = vanillia_require_auth();
        $body = vanillia_read_body();

        $themeMode = in_array($body['theme_mode'] ?? '', ['dark', 'light', 'auto'], true)
            ? (string) $body['theme_mode']
            : (string) $user['theme_mode'];

        $language = in_array($body['language'] ?? '', ['en', 'fr'], true)
            ? (string) $body['language']
            : (string) ($user['language'] ?? 'en');

        $wallpaper = isset($body['wallpaper']) && preg_match('/^[a-z0-9_-]{2,32}$/', (string) $body['wallpaper']) === 1
            ? (string) $body['wallpaper']
            : (string) $user['wallpaper'];

        $accentColor = isset($body['accent_color']) && preg_match('/^#[0-9a-fA-F]{6}$/', (string) $body['accent_color']) === 1
            ? strtoupper((string) $body['accent_color'])
            : (string) $user['accent_color'];

        $lockMinutes = isset($body['session_lock_minutes'])
            ? max(0, min(1440, (int) $body['session_lock_minutes']))
            : (int) $user['session_lock_minutes'];

        $currentPrefs = json_decode((string) ($user['desktop_prefs_json'] ?? '{}'), true) ?: [];
        if (isset($body['desktop_prefs']) && is_array($body['desktop_prefs'])) {
            $currentPrefs = array_merge($currentPrefs, $body['desktop_prefs']);
        }

        $upd = $pdo->prepare(
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
        $upd->execute([
            ':lg' => $language,
            ':tm' => $themeMode,
            ':wp' => $wallpaper,
            ':ac' => $accentColor,
            ':sl' => $lockMinutes,
            ':dp' => json_encode($currentPrefs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ':u'  => gmdate('Y-m-d H:i:s'),
            ':id' => (int) $user['id'],
        ]);

        $_SESSION['session_lock_minutes'] = $lockMinutes;

        $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => (int) $user['id']]);
        vanillia_json_success(['user' => format_public_user($stmt->fetch() ?: $user)]);

    default:
        vanillia_json_error('UNKNOWN_AUTH_ACTION', "Action d'authentification inconnue : {$action}", 404);
}
