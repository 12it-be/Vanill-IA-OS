<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Docker Engine, Compose Stacks, App Store, Docker Hub & Proxy API
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'overview'));
$pdo = vanillia_db();
$agent = new AgentClient();

const VANILLIA_REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/12it-be/Vanill-ia-OS/main/package/usr/share/vanill-ia-os/config/app-store.json';
const VANILLIA_CATALOG_CACHE_PRIMARY = '/var/lib/vanill-ia-os/app-store-cache.json';
const VANILLIA_HUB_CACHE_DIR = '/tmp/vanill-ia-hub-cache';
const VANILLIA_HUB_CACHE_TTL = 300; // 5 minutes

/**
 * Resolves the writable path for the online-synced App Store catalog cache.
 */
function resolve_catalog_cache_path(): string
{
    $primaryDir = dirname(VANILLIA_CATALOG_CACHE_PRIMARY);
    if (is_file(VANILLIA_CATALOG_CACHE_PRIMARY) || (is_dir($primaryDir) && is_writable($primaryDir))) {
        return VANILLIA_CATALOG_CACHE_PRIMARY;
    }
    return vanillia_data_dir() . '/app-store-cache.json';
}

/**
 * Validates that a decoded JSON structure is a clean App Store catalog array.
 *
 * @param mixed $decoded
 */
function is_valid_catalog_payload(mixed $decoded): bool
{
    if (!is_array($decoded) || $decoded === []) {
        return false;
    }
    foreach ($decoded as $entry) {
        if (
            !is_array($entry)
            || empty($entry['slug']) || !is_string($entry['slug'])
            || empty($entry['name']) || !is_string($entry['name'])
            || empty($entry['compose_yml']) || !is_string($entry['compose_yml'])
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Loads the App Store catalog (online-synced cache if available, otherwise bundled JSON).
 * When `$forceRefresh` is true, fetches and validates the latest catalog from GitHub.
 *
 * @return array{items: list<array<string, mixed>>, source: string, updated_at: ?int}
 */
function load_app_store_catalog_state(bool $forceRefresh = false): array
{
    $cachePath = resolve_catalog_cache_path();

    if ($forceRefresh) {
        $ch = curl_init(VANILLIA_REMOTE_CATALOG_URL);
        if ($ch === false) {
            vanillia_json_error('CURL_INIT_ERROR', 'Unable to initialize HTTP client.', 500);
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 3,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_USERAGENT      => 'Vanill-IA-OS/' . VANILLIA_VERSION,
            CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        ]);
        $raw = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($raw === false || $code < 200 || $code >= 300) {
            vanillia_json_error(
                'CATALOG_SYNC_FAILED',
                sprintf('Unable to download remote catalog (HTTP %d%s).', $code, $err !== '' ? ": {$err}" : ''),
                502
            );
        }

        $decoded = json_decode((string) $raw, true);
        if (!is_valid_catalog_payload($decoded)) {
            vanillia_json_error('INVALID_CATALOG_JSON', 'Remote catalog JSON failed schema validation.', 502);
        }

        $formatted = json_encode($decoded, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($formatted !== false) {
            @file_put_contents($cachePath, $formatted . "\n", LOCK_EX);
            @chmod($cachePath, 0644);
        }

        return [
            'items'      => $decoded,
            'source'     => 'remote',
            'updated_at' => time(),
        ];
    }

    if (is_readable($cachePath)) {
        $cached = json_decode((string) file_get_contents($cachePath), true);
        if (is_valid_catalog_payload($cached)) {
            return [
                'items'      => $cached,
                'source'     => 'cache',
                'updated_at' => (int) filemtime($cachePath),
            ];
        }
    }

    $bundled = dirname(__DIR__) . '/config/app-store.json';
    if (is_readable($bundled)) {
        $decoded = json_decode((string) file_get_contents($bundled), true);
        if (is_array($decoded)) {
            return [
                'items'      => $decoded,
                'source'     => 'bundled',
                'updated_at' => (int) filemtime($bundled),
            ];
        }
    }

    return ['items' => [], 'source' => 'empty', 'updated_at' => null];
}

/**
 * Fetches JSON from Docker Hub v2 API with a lightweight 5-minute file cache in `/tmp/vanill-ia-hub-cache/`.
 *
 * @return array<string, mixed>
 */
function fetch_docker_hub_cached(string $url, string $cacheKey): array
{
    if (!is_dir(VANILLIA_HUB_CACHE_DIR)) {
        @mkdir(VANILLIA_HUB_CACHE_DIR, 0700, true);
    }

    $cacheFile = VANILLIA_HUB_CACHE_DIR . '/' . hash('sha256', $cacheKey) . '.json';
    if (is_readable($cacheFile) && (time() - (int) filemtime($cacheFile)) < VANILLIA_HUB_CACHE_TTL) {
        $cached = json_decode((string) file_get_contents($cacheFile), true);
        if (is_array($cached)) {
            return $cached;
        }
    }

    $ch = curl_init($url);
    if ($ch === false) {
        vanillia_json_error('CURL_INIT_ERROR', 'Unable to initialize cURL.', 500);
    }

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_TIMEOUT        => 6,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_USERAGENT      => 'Vanill-IA-OS/' . VANILLIA_VERSION . ' (+https://vanill-ia.com)',
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);

    $raw = curl_exec($ch);
    $err = curl_error($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false || $httpCode < 200 || $httpCode >= 300) {
        vanillia_json_error(
            'DOCKER_HUB_UNAVAILABLE',
            sprintf('Docker Hub API request failed (HTTP %d%s).', $httpCode, $err !== '' ? ": {$err}" : ''),
            502
        );
    }

    $decoded = json_decode((string) $raw, true);
    if (!is_array($decoded)) {
        vanillia_json_error('DOCKER_HUB_INVALID_JSON', 'Invalid JSON received from Docker Hub.', 502);
    }

    @file_put_contents($cacheFile, (string) $raw, LOCK_EX);
    return $decoded;
}

try {
    switch ($action) {
        // ----------------------------------------------------------------------
        // 1. Docker Engine Status & Asynchronous 1-Click Install
        // ----------------------------------------------------------------------
        case 'engine_status':
            $user = vanillia_require_auth(false, false);
            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'agent_online'      => false,
                    'installed'         => false,
                    'running'           => false,
                    'compose_available' => false,
                    'installing'        => false,
                    'install_exit_code' => null,
                    'log_tail'          => '',
                ]);
            }
            $st = $agent->call('docker.status', [], 8);
            $st['agent_online'] = true;
            vanillia_json_success($st);

        case 'install_engine':
            $user = vanillia_require_admin();
            $st = $agent->call('docker.install_engine', [], 15);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'docker.install_engine');
            vanillia_json_success($st);

        case 'start_service':
            $user = vanillia_require_admin();
            $st = $agent->call('docker.service_start', [], 35);
            push_system_notification($pdo, (int) $user['id'], 'success', 'Docker service started', 'docker.service is now active.', null, null, 'docker');
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'docker.service_start');
            vanillia_json_success($st);

        // ----------------------------------------------------------------------
        // 2. Docker Overview: Daemon Info + Containers + Live Stats + Routes
        // ----------------------------------------------------------------------
        case 'overview':
            $user = vanillia_require_auth();

            $routes = $pdo->query('SELECT * FROM proxy_routes ORDER BY fqdn ASC')->fetchAll();
            $pinnedRows = $pdo->prepare('SELECT app_id, container_name, target_url, open_mode FROM desktop_shortcuts WHERE app_type IN ("docker", "webapp") AND (user_id IS NULL OR user_id = :uid)');
            $pinnedRows->execute([':uid' => (int) $user['id']]);
            $pinnedShortcuts = $pinnedRows->fetchAll();

            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'agent_online'  => false,
                    'docker_status' => [
                        'installed'         => false,
                        'running'           => false,
                        'compose_available' => false,
                        'installing'        => false,
                        'install_exit_code' => null,
                        'log_tail'          => '',
                    ],
                    'docker_info'   => null,
                    'containers'    => [],
                    'stats'         => [],
                    'routes'        => $routes,
                    'pinned'        => $pinnedShortcuts,
                ]);
            }

            $dockerStatus = $agent->call('docker.status', [], 8);
            $info = null;
            $containers = [];
            $stats = [];
            $dockerError = null;

            if ($dockerStatus['installed'] && $dockerStatus['running']) {
                try {
                    $info = $agent->call('docker.info', [], 8);
                    $containers = $agent->call('docker.containers', ['all' => true], 12)['containers'] ?? [];
                    $stats = $agent->call('docker.stats', [], 12)['stats'] ?? [];
                } catch (AgentClientException $e) {
                    $dockerError = $e->getMessage();
                }
            }

            $statsMap = [];
            foreach ($stats as $s) {
                $cleanName = ltrim((string) ($s['name'] ?? ''), '/');
                if ($cleanName !== '') {
                    $statsMap[$cleanName] = $s;
                }
                if (!empty($s['id'])) {
                    $statsMap[(string) $s['id']] = $s;
                }
            }

            $routesByContainer = [];
            $routesByPort = [];
            foreach ($routes as $r) {
                if (!empty($r['container_name'])) {
                    $routesByContainer[(string) $r['container_name']] = $r;
                }
                $routesByPort[(int) $r['target_port']] = $r;
            }

            $pinnedByContainer = [];
            foreach ($pinnedShortcuts as $ps) {
                if (!empty($ps['container_name'])) {
                    $pinnedByContainer[(string) $ps['container_name']] = $ps;
                }
            }

            foreach ($containers as &$c) {
                $name = (string) $c['name'];
                $id = (string) $c['id'];
                $c['live_stats'] = $statsMap[$name] ?? $statsMap[$id] ?? null;

                $matchedRoute = $routesByContainer[$name]
                    ?? ($c['web_port'] !== null ? ($routesByPort[(int) $c['web_port']] ?? null) : null);

                if ($matchedRoute !== null) {
                    $scheme = ($matchedRoute['tls_mode'] ?? 'auto') === 'off' ? 'http' : 'https';
                    $c['proxy_url'] = $scheme . '://' . $matchedRoute['fqdn'];
                } else {
                    $c['proxy_url'] = null;
                }

                $c['pinned_shortcut'] = $pinnedByContainer[$name] ?? null;
            }
            unset($c);

            vanillia_json_success([
                'agent_online'  => true,
                'docker_status' => $dockerStatus,
                'docker_error'  => $dockerError,
                'docker_info'   => $info,
                'containers'    => $containers,
                'routes'        => $routes,
                'pinned'        => $pinnedShortcuts,
            ]);

        // ----------------------------------------------------------------------
        // 3. Container Lifecycle, Logs & Exec
        // ----------------------------------------------------------------------
        case 'container_action':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $id = trim((string) ($body['id'] ?? ''));
            $op = trim((string) ($body['operation'] ?? ''));

            $res = $agent->call('docker.container.action', [
                'id'        => $id,
                'operation' => $op,
                'force'     => !empty($body['force']),
                'volumes'   => !empty($body['volumes']),
            ], 30);

            if ($op !== 'inspect') {
                push_system_notification(
                    $pdo,
                    (int) $user['id'],
                    in_array($op, ['stop', 'remove'], true) ? 'warning' : 'info',
                    "Docker container {$op}: {$id}",
                    "Container operation '{$op}' completed on {$id}.",
                    null,
                    null,
                    'docker'
                );
            }

            vanillia_audit_log((int) $user['id'], (string) $user['username'], "docker.container.{$op}", $id);
            vanillia_json_success($res);

        case 'container_logs':
            $user = vanillia_require_auth();
            $id = trim((string) ($_GET['id'] ?? ''));
            $lines = max(20, min(1000, (int) ($_GET['lines'] ?? 200)));

            $res = $agent->call('docker.container.logs', [
                'id'    => $id,
                'lines' => $lines,
            ], 15);

            vanillia_json_success($res);

        case 'container_exec':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $id = trim((string) ($body['id'] ?? ''));
            $command = trim((string) ($body['command'] ?? ''));

            $res = $agent->call('docker.container.exec', [
                'id'      => $id,
                'command' => $command,
            ], 35);

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'docker.container.exec', $id, ['cmd' => $command]);
            vanillia_json_success($res);

        // ----------------------------------------------------------------------
        // 4. Compose Stacks (/opt/vanill-ia/stacks/<app>/)
        // ----------------------------------------------------------------------
        case 'stacks_list':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success(['stacks' => []]);
            }
            vanillia_json_success($agent->call('docker.stacks.list', [], 10));

        case 'stack_get':
            $user = vanillia_require_auth();
            $name = trim((string) ($_GET['name'] ?? ''));
            vanillia_json_success($agent->call('docker.stacks.get', ['name' => $name], 10));

        case 'stack_save':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $name = trim((string) ($body['name'] ?? ''));
            $composeYml = (string) ($body['compose_yml'] ?? '');
            $envContent = (string) ($body['env_content'] ?? '');

            $res = $agent->call('docker.stacks.save', [
                'name'        => $name,
                'compose_yml' => $composeYml,
                'env_content' => $envContent,
            ], 20);

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'docker.stack.save', $name);
            vanillia_json_success($res);

        case 'stack_action':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $name = trim((string) ($body['name'] ?? ''));
            $op = trim((string) ($body['operation'] ?? ''));

            $res = $agent->call('docker.stacks.action', [
                'name'      => $name,
                'operation' => $op,
            ], 300);

            push_system_notification(
                $pdo,
                (int) $user['id'],
                in_array($op, ['down', 'delete'], true) ? 'warning' : 'success',
                "Docker stack {$op}: {$name}",
                "Compose operation '{$op}' completed on stack '{$name}'.",
                null,
                null,
                'docker'
            );

            vanillia_audit_log((int) $user['id'], (string) $user['username'], "docker.stack.{$op}", $name);
            vanillia_json_success($res);

        // ----------------------------------------------------------------------
        // 5. Online-Synced Compose App Catalog (`store_catalog` / `catalog`)
        // ----------------------------------------------------------------------
        case 'store_catalog':
        case 'catalog':
            $user = vanillia_require_auth();
            $refresh = ((string) ($_GET['refresh'] ?? '0')) === '1';
            if ($refresh && ($user['role'] ?? '') !== 'admin') {
                vanillia_json_error('FORBIDDEN', 'Admin role required to refresh online catalog.', 403);
            }

            $catalogState = load_app_store_catalog_state($refresh);
            $catalog = $catalogState['items'];

            $installedStacks = [];
            $dockerStatus = [
                'installed'         => false,
                'running'           => false,
                'compose_available' => false,
                'installing'        => false,
                'install_exit_code' => null,
                'log_tail'          => '',
            ];
            if ($agent->isAvailable()) {
                try {
                    $dockerStatus = $agent->call('docker.status', [], 8);
                    if ($dockerStatus['installed']) {
                        $list = $agent->call('docker.stacks.list', [], 8)['stacks'] ?? [];
                        foreach ($list as $st) {
                            $installedStacks[(string) $st['name']] = true;
                        }
                    }
                } catch (Throwable) {
                }
            }

            foreach ($catalog as &$app) {
                $app['installed'] = isset($installedStacks[(string) $app['slug']]);
            }
            unset($app);

            vanillia_json_success([
                'catalog'       => $catalog,
                'source'        => $catalogState['source'],
                'updated_at'    => $catalogState['updated_at'],
                'docker_status' => $dockerStatus,
                'agent_online'  => $agent->isAvailable(),
            ]);

        case 'catalog_deploy':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $slug = strtolower(trim((string) ($body['slug'] ?? '')));
            $hostPort = (int) ($body['port'] ?? 0);
            $pinDesktop = !empty($body['pin_desktop']);
            $openMode = in_array($body['open_mode'] ?? '', ['iframe', 'tab'], true) ? (string) $body['open_mode'] : 'iframe';

            $catalog = load_app_store_catalog_state(false)['items'];
            $template = null;
            foreach ($catalog as $item) {
                if (($item['slug'] ?? '') === $slug) {
                    $template = $item;
                    break;
                }
            }

            if ($template === null) {
                vanillia_json_error('APP_NOT_FOUND', "Application not found in catalog: {$slug}", 404);
            }

            $finalPort = ($hostPort >= 1 && $hostPort <= 65535) ? $hostPort : (int) $template['default_port'];
            $envContent = "APP_PORT={$finalPort}\n";
            if (!empty($body['extra_env']) && is_string($body['extra_env'])) {
                $envContent .= trim($body['extra_env']) . "\n";
            }

            $agent->call('docker.stacks.save', [
                'name'        => $slug,
                'compose_yml' => (string) $template['compose_yml'],
                'env_content' => $envContent,
            ], 20);

            $deployRes = $agent->call('docker.stacks.action', [
                'name'      => $slug,
                'operation' => 'up',
            ], 300);

            $hostOnly = explode(':', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost'))[0];
            $deployedUrl = "http://{$hostOnly}:{$finalPort}";

            if ($pinDesktop) {
                $pinStmt = $pdo->prepare(
                    'INSERT INTO desktop_shortcuts (user_id, app_id, app_type, title, subtitle, icon, accent_color, url, target_url, container_name, open_mode, pinned_desktop, pinned_dock, sort_order)
                     VALUES (:uid, :aid, "docker", :title, :sub, :icon, :acc, :url, :turl, :cname, :mode, 1, 1, 210)
                     ON CONFLICT(COALESCE(user_id, 0), app_id) DO UPDATE SET
                        url = excluded.url,
                        target_url = excluded.target_url,
                        open_mode = excluded.open_mode,
                        pinned_desktop = 1'
                );
                $pinStmt->execute([
                    ':uid'   => (int) $user['id'],
                    ':aid'   => 'app-' . $slug,
                    ':title' => (string) $template['name'],
                    ':sub'   => (string) $template['category'],
                    ':icon'  => (string) ($template['icon'] ?? 'box'),
                    ':acc'   => (string) ($template['accent_color'] ?? '#0EA5E9'),
                    ':url'   => $deployedUrl,
                    ':turl'  => $deployedUrl,
                    ':cname' => $slug,
                    ':mode'  => $openMode,
                ]);
            }

            push_system_notification(
                $pdo,
                (int) $user['id'],
                'success',
                "App deployed: {$template['name']}",
                "Stack '{$slug}' is running on port {$finalPort}.",
                $deployedUrl,
                'Open',
                'docker'
            );

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'docker.appstore.deploy', $slug, ['port' => $finalPort]);

            vanillia_json_success([
                'deployed' => true,
                'slug'     => $slug,
                'port'     => $finalPort,
                'output'   => $deployRes['output'] ?? '',
            ]);

        // ----------------------------------------------------------------------
        // 6. Official Docker Hub Search, Image Tags & Custom Image Deployment
        // ----------------------------------------------------------------------
        case 'hub_search':
            $user = vanillia_require_auth();
            $q = trim((string) ($_GET['q'] ?? ''));
            $officialOnly = ((string) ($_GET['official_only'] ?? '1')) !== '0';

            $effectiveQuery = $q !== '' ? $q : 'library';
            if (strlen($effectiveQuery) > 100) {
                $effectiveQuery = substr($effectiveQuery, 0, 100);
            }

            $pageSize = $officialOnly ? 50 : 24;
            $hubUrl = 'https://hub.docker.com/v2/search/repositories/?query='
                . rawurlencode($effectiveQuery)
                . '&page_size=' . $pageSize;

            $json = fetch_docker_hub_cached($hubUrl, "hub_search:{$effectiveQuery}:{$pageSize}");
            $rawResults = is_array($json['results'] ?? null) ? $json['results'] : [];
            $results = [];

            foreach ($rawResults as $item) {
                if (!is_array($item)) {
                    continue;
                }
                $isOfficial = !empty($item['is_official']);
                if ($officialOnly && !$isOfficial) {
                    continue;
                }

                $results[] = [
                    'repo_name'         => (string) ($item['repo_name'] ?? ''),
                    'short_description' => (string) ($item['short_description'] ?? ''),
                    'is_official'       => $isOfficial,
                    'star_count'        => (int) ($item['star_count'] ?? 0),
                    'pull_count'        => (int) ($item['pull_count'] ?? 0),
                ];

                if (count($results) >= 24) {
                    break;
                }
            }

            vanillia_json_success([
                'query'         => $q,
                'official_only' => $officialOnly,
                'results'       => $results,
            ]);

        case 'hub_tags':
            $user = vanillia_require_auth();
            $repo = trim((string) ($_GET['repo'] ?? ''));

            if ($repo === '' || preg_match('#^[a-zA-Z0-9._-]+(/[a-zA-Z0-9._-]+)?$#', $repo) !== 1) {
                vanillia_json_error('INVALID_REPO_NAME', 'Invalid Docker Hub repository name.');
            }

            $repoPath = str_contains($repo, '/') ? $repo : "library/{$repo}";
            $tagsUrl = "https://hub.docker.com/v2/repositories/{$repoPath}/tags?page_size=20";
            $json = fetch_docker_hub_cached($tagsUrl, "hub_tags:{$repoPath}");

            $rawTags = is_array($json['results'] ?? null) ? $json['results'] : [];
            $tags = [];
            $hasLatest = false;

            foreach ($rawTags as $tItem) {
                if (!is_array($tItem) || empty($tItem['name'])) {
                    continue;
                }
                $tagName = (string) $tItem['name'];
                if ($tagName === 'latest') {
                    $hasLatest = true;
                }
                $tags[] = [
                    'name'         => $tagName,
                    'full_size'    => isset($tItem['full_size']) ? (int) $tItem['full_size'] : 0,
                    'last_updated' => (string) ($tItem['last_updated'] ?? ''),
                ];
            }

            if (!$hasLatest) {
                array_unshift($tags, [
                    'name'         => 'latest',
                    'full_size'    => 0,
                    'last_updated' => '',
                ]);
            } else {
                usort($tags, static fn (array $a, array $b): int => $a['name'] === 'latest' ? -1 : ($b['name'] === 'latest' ? 1 : 0));
            }

            vanillia_json_success([
                'repo' => $repo,
                'tags' => $tags,
            ]);

        case 'deploy_image':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();

            $name = strtolower(trim((string) ($body['name'] ?? '')));
            $image = trim((string) ($body['image'] ?? ''));
            $tag = trim((string) ($body['tag'] ?? 'latest')) ?: 'latest';
            $restartPolicy = trim((string) ($body['restart_policy'] ?? 'unless-stopped'));
            $pinDesktop = !empty($body['pin_desktop']);

            if (preg_match('/^[a-z0-9][a-z0-9_-]{0,47}$/', $name) !== 1) {
                vanillia_json_error('INVALID_SERVICE_NAME', 'Service name must use lowercase letters, digits, hyphens or underscores.');
            }
            if ($image === '' || preg_match('#^[a-zA-Z0-9._/-]{1,160}$#', $image) !== 1 || str_contains($image, '..')) {
                vanillia_json_error('INVALID_IMAGE_NAME', 'Invalid Docker image name.');
            }
            if (preg_match('/^[a-zA-Z0-9._-]{1,128}$/', $tag) !== 1) {
                vanillia_json_error('INVALID_IMAGE_TAG', 'Invalid Docker image tag.');
            }
            if (!in_array($restartPolicy, ['no', 'always', 'on-failure', 'unless-stopped'], true)) {
                $restartPolicy = 'unless-stopped';
            }

            // Validate ports (`host:container` or `{host, container, proto}`)
            $validPorts = [];
            $firstHostPort = null;
            $rawPorts = is_array($body['ports'] ?? null) ? $body['ports'] : [];
            foreach ($rawPorts as $pEntry) {
                $portStr = '';
                if (is_string($pEntry)) {
                    $portStr = trim($pEntry);
                } elseif (is_array($pEntry)) {
                    $hp = trim((string) ($pEntry['host'] ?? ''));
                    $cp = trim((string) ($pEntry['container'] ?? ''));
                    $pr = strtolower(trim((string) ($pEntry['proto'] ?? 'tcp')));
                    if ($hp !== '' && $cp !== '') {
                        $portStr = $pr === 'udp' ? "{$hp}:{$cp}/udp" : "{$hp}:{$cp}";
                    }
                }
                if ($portStr === '') {
                    continue;
                }
                if (preg_match('#^(\d{1,5}):(\d{1,5})(/(tcp|udp))?$#', $portStr, $pm) !== 1) {
                    vanillia_json_error('INVALID_PORT_MAPPING', "Invalid port mapping: {$portStr} (expected host:container).");
                }
                $hPort = (int) $pm[1];
                $cPort = (int) $pm[2];
                if ($hPort < 1 || $hPort > 65535 || $cPort < 1 || $cPort > 65535) {
                    vanillia_json_error('PORT_OUT_OF_RANGE', "Port number out of range (1-65535): {$portStr}");
                }
                if ($firstHostPort === null && (($pm[4] ?? 'tcp') === 'tcp')) {
                    $firstHostPort = $hPort;
                }
                $validPorts[] = $portStr;
            }

            // Validate volumes (`host:container` or `{host, container}`)
            $validVolumes = [];
            $rawVolumes = is_array($body['volumes'] ?? null) ? $body['volumes'] : [];
            foreach ($rawVolumes as $vEntry) {
                $volStr = '';
                if (is_string($vEntry)) {
                    $volStr = trim($vEntry);
                } elseif (is_array($vEntry)) {
                    $hv = trim((string) ($vEntry['host'] ?? ''));
                    $cv = trim((string) ($vEntry['container'] ?? ''));
                    if ($hv !== '' && $cv !== '') {
                        $volStr = "{$hv}:{$cv}";
                    }
                }
                if ($volStr === '') {
                    continue;
                }
                if (preg_match('/[\r\n\0"\'`]/', $volStr) === 1 || str_contains($volStr, '..') || substr_count($volStr, ':') < 1) {
                    vanillia_json_error('INVALID_VOLUME_MAPPING', "Invalid volume mapping: {$volStr}");
                }
                [$hPath, $cPath] = explode(':', $volStr, 2);
                if ((!str_starts_with($hPath, '/') && !str_starts_with($hPath, './')) || !str_starts_with($cPath, '/')) {
                    vanillia_json_error('INVALID_VOLUME_PATH', "Volume paths must be absolute or ./ relative: {$volStr}");
                }
                if (str_starts_with($hPath, '/etc/shadow') || str_starts_with($hPath, '/var/lib/vanill-ia-os/data')) {
                    vanillia_json_error('FORBIDDEN_VOLUME_PATH', 'Mounting protected system security paths is forbidden.', 403);
                }
                $validVolumes[] = $volStr;
            }

            // Validate environment variables (`KEY=VALUE` or `{key, value}`)
            $validEnv = [];
            $rawEnv = is_array($body['env'] ?? null) ? $body['env'] : [];
            foreach ($rawEnv as $eEntry) {
                $k = '';
                $v = '';
                if (is_string($eEntry) && str_contains($eEntry, '=')) {
                    [$k, $v] = explode('=', $eEntry, 2);
                } elseif (is_array($eEntry)) {
                    $k = (string) ($eEntry['key'] ?? '');
                    $v = (string) ($eEntry['value'] ?? '');
                }
                $k = trim($k);
                $v = str_replace(["\r", "\n", "\0"], '', $v);
                if ($k === '') {
                    continue;
                }
                if (preg_match('/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/', $k) !== 1) {
                    vanillia_json_error('INVALID_ENV_KEY', "Invalid environment variable name: {$k}");
                }
                $validEnv[$k] = $v;
            }

            // Build clean docker-compose.yml
            $fullImage = "{$image}:{$tag}";
            $yamlLines = [
                'services:',
                "  {$name}:",
                "    image: \"{$fullImage}\"",
                "    container_name: {$name}",
                "    restart: {$restartPolicy}",
            ];

            if ($validPorts !== []) {
                $yamlLines[] = '    ports:';
                foreach ($validPorts as $pStr) {
                    $yamlLines[] = "      - \"{$pStr}\"";
                }
            }

            if ($validVolumes !== []) {
                $yamlLines[] = '    volumes:';
                foreach ($validVolumes as $vStr) {
                    $yamlLines[] = "      - \"{$vStr}\"";
                }
            }

            if ($validEnv !== []) {
                $yamlLines[] = '    environment:';
                foreach ($validEnv as $envKey => $envVal) {
                    $escapedVal = str_replace(['\\', '"', '$'], ['\\\\', '\\"', '$$'], $envVal);
                    $yamlLines[] = "      - \"{$envKey}={$escapedVal}\"";
                }
            }

            $composeYml = implode("\n", $yamlLines) . "\n";

            // Save & validate YAML, then run `docker compose up -d`
            $agent->call('docker.stacks.save', [
                'name'        => $name,
                'compose_yml' => $composeYml,
                'env_content' => '',
            ], 20);

            $deployRes = $agent->call('docker.stacks.action', [
                'name'      => $name,
                'operation' => 'up',
            ], 300);

            $deployedUrl = null;
            if ($firstHostPort !== null) {
                $hostOnly = explode(':', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost'))[0];
                $deployedUrl = "http://{$hostOnly}:{$firstHostPort}";

                if ($pinDesktop) {
                    $pinStmt = $pdo->prepare(
                        'INSERT INTO desktop_shortcuts (user_id, app_id, app_type, title, subtitle, icon, accent_color, url, target_url, container_name, open_mode, pinned_desktop, pinned_dock, sort_order)
                         VALUES (:uid, :aid, "docker", :title, :sub, "layers", "#0EA5E9", :url, :turl, :cname, "iframe", 1, 1, 215)
                         ON CONFLICT(COALESCE(user_id, 0), app_id) DO UPDATE SET
                            url = excluded.url,
                            target_url = excluded.target_url,
                            pinned_desktop = 1'
                    );
                    $pinStmt->execute([
                        ':uid'   => (int) $user['id'],
                        ':aid'   => 'app-' . $name,
                        ':title' => $name,
                        ':sub'   => $fullImage,
                        ':url'   => $deployedUrl,
                        ':turl'  => $deployedUrl,
                        ':cname' => $name,
                    ]);
                }
            }

            push_system_notification(
                $pdo,
                (int) $user['id'],
                'success',
                "Image deployed: {$fullImage}",
                sprintf("Stack '%s' deployed%s.", $name, $firstHostPort !== null ? " on port {$firstHostPort}" : ''),
                $deployedUrl,
                $deployedUrl !== null ? 'Open' : null,
                'docker'
            );

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'docker.deploy_image', $fullImage, [
                'stack' => $name,
                'port'  => $firstHostPort,
            ]);

            vanillia_json_success([
                'deployed' => true,
                'name'     => $name,
                'image'    => $fullImage,
                'port'     => $firstHostPort,
                'output'   => $deployRes['output'] ?? '',
            ]);

        // ----------------------------------------------------------------------
        // 7. Reverse Proxy Caddy (/etc/caddy/conf.d/app-*.caddy)
        // ----------------------------------------------------------------------
        case 'proxy_list':
            $user = vanillia_require_auth();
            $routes = $pdo->query('SELECT * FROM proxy_routes ORDER BY fqdn ASC')->fetchAll();
            vanillia_json_success(['routes' => $routes]);

        case 'proxy_save':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();

            $res = $agent->call('caddy.proxy.save', [
                'fqdn'           => $body['fqdn'] ?? '',
                'target_host'    => $body['target_host'] ?? '127.0.0.1',
                'target_port'    => (int) ($body['target_port'] ?? 0),
                'target_scheme'  => $body['target_scheme'] ?? 'http',
                'tls_mode'       => $body['tls_mode'] ?? 'auto',
                'container_name' => $body['container_name'] ?? null,
            ], 25);

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'caddy.proxy.save', (string) ($body['fqdn'] ?? ''));
            vanillia_json_success($res);

        case 'proxy_delete':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $id = (int) ($body['id'] ?? 0);

            $res = $agent->call('caddy.proxy.delete', ['id' => $id], 20);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'caddy.proxy.delete', (string) $id);
            vanillia_json_success($res);

        default:
            vanillia_json_error('UNKNOWN_DOCKER_ACTION', "Unknown Docker action: {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
