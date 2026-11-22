-- ==============================================================================
-- Vanill-IA OS — Initial SQLite3 Database Schema (3-Layer Hardened Security)
-- Location at runtime: /var/lib/vanill-ia-os/data/vanill-ia.db
-- Idempotent: safe to re-run during package upgrades (postinst)
-- ==============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ------------------------------------------------------------------------------
-- 1. Utilisateurs, 2FA TOTP (RFC 6238) & Préférences du Bureau WebOS
--    Note: Zéro compte par défaut à l'installation -> Setup Wizard verrouillé après création
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    username               TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash          TEXT    NOT NULL,
    display_name           TEXT    NOT NULL DEFAULT 'Administrateur',
    role                   TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
    must_change_password   INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    totp_enabled           INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
    totp_secret            TEXT    DEFAULT NULL,
    totp_backup_codes_json TEXT    NOT NULL DEFAULT '[]',
    session_lock_minutes   INTEGER NOT NULL DEFAULT 15,
    language               TEXT    NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'fr')),
    theme_mode             TEXT    NOT NULL DEFAULT 'dark' CHECK (theme_mode IN ('dark', 'light', 'auto')),
    wallpaper              TEXT    NOT NULL DEFAULT 'aurora-coral',
    accent_color           TEXT    NOT NULL DEFAULT '#FF6D5A',
    desktop_prefs_json     TEXT    NOT NULL DEFAULT '{"dockMagnification":true,"showSystemWidgets":true,"blurIntensity":"high","openContainersInIframe":true}',
    last_login_at          TEXT    DEFAULT NULL,
    last_login_ip          TEXT    DEFAULT NULL,
    created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

-- ------------------------------------------------------------------------------
-- 2. Anti-Bruteforce & Rate Limiting Applicatif (Couplé à /var/log/vanill-ia-auth.log)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_attempts (
    ip_address     TEXT    PRIMARY KEY,
    fail_count     INTEGER NOT NULL DEFAULT 0,
    first_fail_at  INTEGER NOT NULL DEFAULT 0,
    last_fail_at   INTEGER NOT NULL DEFAULT 0,
    locked_until   INTEGER NOT NULL DEFAULT 0,
    last_username  TEXT    DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_locked ON auth_attempts(locked_until);

-- ------------------------------------------------------------------------------
-- 3. Paramètres Globaux de l'OS & Isolation Réseau
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'general',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

INSERT OR IGNORE INTO settings (key, value, category) VALUES
    ('os.name', 'Vanill-IA OS', 'general'),
    ('os.hostname_label', 'Serveur Debian', 'general'),
    ('os.base_domain', '', 'network'),
    ('os.acme_email', '', 'network'),
    ('os.metrics_interval_ms', '3000', 'monitoring'),
    ('security.setup_completed', '0', 'security'),
    ('security.setup_token_hash', '', 'security'),
    ('security.require_token_on_lan', '0', 'security'),
    ('security.network_exposure', 'all', 'security'),
    ('security.custom_allowed_cidrs', '', 'security'),
    ('security.max_login_attempts', '5', 'security'),
    ('security.lockout_minutes', '15', 'security'),
    ('docker.stacks_dir', '/opt/vanill-ia/stacks', 'docker'),
    ('notes.storage_dir', '/var/lib/vanill-ia-os/notes', 'apps'),
    ('files.root_dir', '/', 'apps'),
    ('ai.sysadmin_auto_context', '1', 'ai');

-- ------------------------------------------------------------------------------
-- 4. Raccourcis Bureau, Liens Web Externes & Applications Épinglées
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS desktop_shortcuts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id         TEXT    NOT NULL,
    app_type       TEXT    NOT NULL DEFAULT 'system' CHECK (app_type IN ('system', 'docker', 'webapp', 'shortcut')),
    title          TEXT    NOT NULL,
    subtitle       TEXT    NOT NULL DEFAULT '',
    icon           TEXT    NOT NULL DEFAULT 'globe',
    icon_url       TEXT    DEFAULT NULL,
    accent_color   TEXT    NOT NULL DEFAULT '#FF6D5A',
    url            TEXT    DEFAULT NULL,
    target_url     TEXT    DEFAULT NULL,
    container_name TEXT    DEFAULT NULL,
    open_mode      TEXT    NOT NULL DEFAULT 'external' CHECK (open_mode IN ('window', 'iframe', 'tab', 'external', 'remote_browser')),
    pinned_desktop INTEGER NOT NULL DEFAULT 1 CHECK (pinned_desktop IN (0, 1)),
    pinned_dock    INTEGER NOT NULL DEFAULT 0 CHECK (pinned_dock IN (0, 1)),
    sort_order     INTEGER NOT NULL DEFAULT 100,
    created_at     INTEGER NOT NULL DEFAULT ( CAST(strftime('%s', 'now') AS INTEGER) )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shortcuts_unique_app
    ON desktop_shortcuts(COALESCE(user_id, 0), app_id);

-- ------------------------------------------------------------------------------
-- 4b. Partage Public de Fichiers ("Mini-WeTransfer" via /share.php)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_shares (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    token          TEXT    NOT NULL UNIQUE,
    file_path      TEXT    NOT NULL,
    file_name      TEXT    NOT NULL,
    file_size      INTEGER NOT NULL DEFAULT 0,
    password_hash  TEXT    DEFAULT NULL,
    expires_at     INTEGER DEFAULT NULL,
    max_downloads  INTEGER DEFAULT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    created_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_shares_token ON file_shares(token);
CREATE INDEX IF NOT EXISTS idx_file_shares_creator ON file_shares(created_by, created_at DESC);

INSERT OR IGNORE INTO desktop_shortcuts
    (user_id, app_id, app_type, title, subtitle, icon, accent_color, open_mode, pinned_desktop, pinned_dock, sort_order)
VALUES
    (NULL, 'docker-manager',   'system', 'Docker & Apps',     'Containers, Stacks & Store',   'layers',      '#0EA5E9', 'window', 1, 1, 10),
    (NULL, 'resource-monitor', 'system', 'Resource Monitor',  'CPU, RAM, Disks & SMART',      'activity',    '#10B981', 'window', 1, 1, 20),
    (NULL, 'file-station',     'system', 'Files',             'File Explorer & Archives',     'folder-open', '#F59E0B', 'window', 1, 1, 30),
    (NULL, 'mount-manager',    'system', 'Mount',             'SMB/CIFS Network Shares',      'harddrive',   '#F97316', 'window', 1, 0, 35),
    (NULL, 'vanill-ia-chat',   'system', 'Vanill-IA',         'AI Chat & SysAdmin Diag',      'sparkles',    '#FF6D5A', 'window', 1, 1, 40),
    (NULL, 'web-browser',      'system', 'Web Browser',       'Isolated Remote Chromium',     'globe',       '#3B82F6', 'window', 1, 1, 45),
    (NULL, 'terminal',         'system', 'Terminal',          'System & Container Shell',     'terminal',    '#64748B', 'window', 1, 1, 50),
    (NULL, 'cron-manager',     'system', 'Cron Scheduler',    'Tasks & SQLite Logs',          'clock',       '#8B5CF6', 'window', 1, 0, 60),
    (NULL, 'system-settings',  'system', 'System Settings',   'Network, 2FA, UFW, APT',       'sliders',     '#3B82F6', 'window', 1, 1, 70),
    (NULL, 'code-editor',      'system', 'Code Editor',       'Configs, Scripts & YAML',      'file-code',   '#EC4899', 'window', 1, 0, 80),
    (NULL, 'notes',            'system', 'Markdown Notes',    'Server Documentation .md',     'book-open',   '#14B8A6', 'window', 1, 0, 90);

-- ------------------------------------------------------------------------------
-- 5. Planificateur de Tâches (Synchronisé avec /etc/cron.d/vanill-ia)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    schedule         TEXT    NOT NULL,
    run_user         TEXT    NOT NULL DEFAULT 'root',
    command          TEXT    NOT NULL,
    working_dir      TEXT    NOT NULL DEFAULT '/root',
    enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    notify_on_fail   INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_fail IN (0, 1)),
    last_run_at      TEXT    DEFAULT NULL,
    last_exit_code   INTEGER DEFAULT NULL,
    last_duration_ms INTEGER DEFAULT NULL,
    last_output      TEXT    DEFAULT NULL,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE TABLE IF NOT EXISTS cron_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    started_at   TEXT    NOT NULL,
    finished_at  TEXT    NOT NULL,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    exit_code    INTEGER NOT NULL DEFAULT 0,
    output       TEXT    NOT NULL DEFAULT '',
    triggered_by TEXT    NOT NULL DEFAULT 'schedule' CHECK (triggered_by IN ('schedule', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_cron_logs_job_id ON cron_logs(job_id, id DESC);

-- ------------------------------------------------------------------------------
-- 6. Routes Reverse Proxy Caddy (/etc/caddy/conf.d/app-*.caddy)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxy_routes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    slug              TEXT    NOT NULL UNIQUE,
    fqdn              TEXT    NOT NULL UNIQUE,
    target_host       TEXT    NOT NULL DEFAULT '127.0.0.1',
    target_port       INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
    target_scheme     TEXT    NOT NULL DEFAULT 'http' CHECK (target_scheme IN ('http', 'https')),
    tls_mode          TEXT    NOT NULL DEFAULT 'auto' CHECK (tls_mode IN ('auto', 'internal', 'off')),
    websocket_support INTEGER NOT NULL DEFAULT 1 CHECK (websocket_support IN (0, 1)),
    container_name    TEXT    DEFAULT NULL,
    config_path       TEXT    NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

-- ------------------------------------------------------------------------------
-- 7. Moteurs IA & Paramètres Complets (Zéro bridage arbitraire — BYOK + Ollama)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_configs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    slug               TEXT    NOT NULL UNIQUE,
    name               TEXT    NOT NULL,
    provider_type      TEXT    NOT NULL CHECK (provider_type IN ('ollama', 'gemini', 'openai', 'openrouter', 'anthropic', 'custom_openai')),
    base_url           TEXT    NOT NULL,
    api_key            TEXT    NOT NULL DEFAULT '',
    model_id           TEXT    NOT NULL,
    context_window     INTEGER NOT NULL DEFAULT 1048576,
    max_output_tokens  INTEGER NOT NULL DEFAULT 65536,
    temperature        REAL    DEFAULT 0.4,
    top_p              REAL    DEFAULT 0.95,
    top_k              INTEGER DEFAULT NULL,
    reasoning_effort   TEXT    DEFAULT NULL,
    supports_vision    INTEGER NOT NULL DEFAULT 1 CHECK (supports_vision IN (0, 1)),
    supports_reasoning INTEGER NOT NULL DEFAULT 1 CHECK (supports_reasoning IN (0, 1)),
    supports_tools     INTEGER NOT NULL DEFAULT 1 CHECK (supports_tools IN (0, 1)),
    system_prompt      TEXT    NOT NULL DEFAULT 'Tu es Vanill-IA, un ingénieur SysAdmin Debian & DevOps senior intégré à Vanill-IA OS. Fournis des diagnostics précis, sécurisés et des commandes directement applicables.',
    extra_headers_json TEXT    NOT NULL DEFAULT '{}',
    extra_body_json    TEXT    NOT NULL DEFAULT '{}',
    timeout_seconds    INTEGER NOT NULL DEFAULT 120,
    is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

INSERT OR IGNORE INTO ai_configs
    (slug, name, provider_type, base_url, api_key, model_id, context_window, max_output_tokens, temperature, top_p, supports_vision, supports_reasoning, supports_tools, is_default, enabled)
VALUES
    ('gemini-default', 'Google Gemini 3.8 Flash (BYOK)', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', '', 'gemini-3.8-flash', 1048576, 65536, 0.3, 0.95, 1, 1, 1, 1, 1),
    ('ollama-local',   'Ollama Local (Auto-hébergé)',    'ollama', 'http://127.0.0.1:11434',                          '', 'qwen2.5-coder:7b', 131072,  16384, 0.2, 0.90, 0, 1, 1, 0, 1),
    ('openrouter',     'OpenRouter (Multi-modèles)',     'openrouter', 'https://openrouter.ai/api/v1',                '', 'google/gemini-3.8-flash', 1048576, 65536, 0.3, 0.95, 1, 1, 1, 0, 1),
    ('openai',         'OpenAI API (BYOK)',              'openai', 'https://api.openai.com/v1',                       '', 'gpt-4.1',          1047576, 32768, 0.3, 1.00, 1, 1, 1, 0, 0);

-- ------------------------------------------------------------------------------
-- 8. Historique des Conversations IA & Diagnostics SysAdmin
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_conversations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    ai_config_id   INTEGER DEFAULT NULL REFERENCES ai_configs(id) ON DELETE SET NULL,
    title          TEXT    NOT NULL DEFAULT 'Nouvelle conversation',
    context_type   TEXT    NOT NULL DEFAULT 'chat' CHECK (context_type IN ('chat', 'docker_diag', 'systemd_diag', 'cron_diag', 'security_diag')),
    context_target TEXT    DEFAULT NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE TABLE IF NOT EXISTS ai_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content         TEXT    NOT NULL,
    reasoning_text  TEXT    DEFAULT NULL,
    tokens_input    INTEGER DEFAULT NULL,
    tokens_output   INTEGER DEFAULT NULL,
    duration_ms     INTEGER DEFAULT NULL,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id, id ASC);

-- ------------------------------------------------------------------------------
-- 9. Centre de Notifications & Journal d'Audit Système
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    level               TEXT    NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warning', 'error')),
    source              TEXT    NOT NULL DEFAULT 'system',
    title               TEXT    NOT NULL,
    message             TEXT    NOT NULL DEFAULT '',
    action_url          TEXT    DEFAULT NULL,
    action_label        TEXT    DEFAULT NULL,
    action_payload_json TEXT    DEFAULT NULL,
    is_read             INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, id DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    username     TEXT    NOT NULL DEFAULT 'system',
    ip_address   TEXT    DEFAULT NULL,
    action       TEXT    NOT NULL,
    target       TEXT    DEFAULT NULL,
    details_json TEXT    NOT NULL DEFAULT '{}',
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(id DESC);
