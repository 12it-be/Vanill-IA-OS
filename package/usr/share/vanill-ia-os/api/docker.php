<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Docker Engine, Compose Stacks, App Store & Caddy Proxy API
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'overview'));
$pdo = vanillia_db();
$agent = new AgentClient();

/**
 * Charge le catalogue JSON de l'App Store 1-clic.
 *
 * @return list<array<string, mixed>>
 */
function load_app_store_catalog(): array
{
    $file = dirname(__DIR__) . '/config/app-store.json';
    if (!is_readable($file)) {
        return [];
    }
    $decoded = json_decode((string) file_get_contents($file), true);
    return is_array($decoded) ? $decoded : [];
}

try {
    switch ($action) {
        // ----------------------------------------------------------------------
        // Vue globale : Infos démon + Conteneurs + Stats live + Routes Proxy
        // ----------------------------------------------------------------------
        case 'overview':
            $user = vanillia_require_auth();

            $routes = $pdo->query('SELECT * FROM proxy_routes ORDER BY fqdn ASC')->fetchAll();
            $pinnedRows = $pdo->prepare('SELECT app_id, container_name, target_url, open_mode FROM desktop_shortcuts WHERE app_type IN ("docker", "webapp") AND (user_id IS NULL OR user_id = :uid)');
            $pinnedRows->execute([':uid' => (int) $user['id']]);
            $pinnedShortcuts = $pinnedRows->fetchAll();

            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'agent_online' => false,
                    'docker_info'  => null,
                    'containers'   => [],
                    'stats'        => [],
                    'routes'       => $routes,
                    'pinned'       => $pinnedShortcuts,
                ]);
            }

            $info = null;
            $containers = [];
            $stats = [];
            $dockerError = null;

            try {
                $info = $agent->call('docker.info', [], 8);
                $containers = $agent->call('docker.containers', ['all' => true], 12)['containers'] ?? [];
                $stats = $agent->call('docker.stats', [], 12)['stats'] ?? [];
            } catch (AgentClientException $e) {
                $dockerError = $e->getMessage();
            }

            // Indexation des stats par nom et ID court
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

            // Indexation des routes Caddy par conteneur ou port
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
                'agent_online' => true,
                'docker_error' => $dockerError,
                'docker_info'  => $info,
                'containers'   => $containers,
                'routes'       => $routes,
                'pinned'       => $pinnedShortcuts,
            ]);

        // ----------------------------------------------------------------------
        // Actions sur un conteneur (start, stop, restart, remove, inspect)
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

        // ----------------------------------------------------------------------
        // Logs d'un conteneur
        // ----------------------------------------------------------------------
        case 'container_logs':
            $user = vanillia_require_auth();
            $id = trim((string) ($_GET['id'] ?? ''));
            $lines = max(20, min(1000, (int) ($_GET['lines'] ?? 200)));

            $res = $agent->call('docker.container.logs', [
                'id'    => $id,
                'lines' => $lines,
            ], 15);

            vanillia_json_success($res);

        // ----------------------------------------------------------------------
        // Exécution rapide de commande dans un conteneur (docker exec)
        // ----------------------------------------------------------------------
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
        // Gestion des Stacks Docker Compose (/opt/vanill-ia/stacks/<app>/)
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
        // Catalogue App Store & Déploiement 1-Clic
        // ----------------------------------------------------------------------
        case 'catalog':
            $user = vanillia_require_auth();
            $catalog = load_app_store_catalog();
            $installedStacks = [];
            if ($agent->isAvailable()) {
                try {
                    $list = $agent->call('docker.stacks.list', [], 8)['stacks'] ?? [];
                    foreach ($list as $st) {
                        $installedStacks[(string) $st['name']] = true;
                    }
                } catch (Throwable) {
                }
            }

            foreach ($catalog as &$app) {
                $app['installed'] = isset($installedStacks[(string) $app['slug']]);
            }
            unset($app);

            vanillia_json_success(['catalog' => $catalog]);

        case 'catalog_deploy':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $slug = strtolower(trim((string) ($body['slug'] ?? '')));
            $hostPort = (int) ($body['port'] ?? 0);
            $pinDesktop = !empty($body['pin_desktop']);
            $openMode = in_array($body['open_mode'] ?? '', ['iframe', 'tab'], true) ? (string) $body['open_mode'] : 'iframe';

            $catalog = load_app_store_catalog();
            $template = null;
            foreach ($catalog as $item) {
                if (($item['slug'] ?? '') === $slug) {
                    $template = $item;
                    break;
                }
            }

            if ($template === null) {
                vanillia_json_error('APP_NOT_FOUND', "Application introuvable dans le catalogue : {$slug}", 404);
            }

            $finalPort = ($hostPort >= 1 && $hostPort <= 65535) ? $hostPort : (int) $template['default_port'];
            $envContent = "APP_PORT={$finalPort}\n";
            if (!empty($body['extra_env']) && is_string($body['extra_env'])) {
                $envContent .= trim($body['extra_env']) . "\n";
            }

            // 1. Écriture et validation du docker-compose.yml dans /opt/vanill-ia/stacks/<slug>/
            $agent->call('docker.stacks.save', [
                'name'        => $slug,
                'compose_yml' => (string) $template['compose_yml'],
                'env_content' => $envContent,
            ], 20);

            // 2. Déploiement docker compose up -d
            $deployRes = $agent->call('docker.stacks.action', [
                'name'      => $slug,
                'operation' => 'up',
            ], 300);

            $hostOnly = explode(':', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost'))[0];
            $deployedUrl = "http://{$hostOnly}:{$finalPort}";

            // 3. Épinglage optionnel sur le Bureau & le Dock
            if ($pinDesktop) {
                $targetUrl = $deployedUrl;

                $pinStmt = $pdo->prepare(
                    'INSERT INTO desktop_shortcuts (user_id, app_id, app_type, title, subtitle, icon, accent_color, target_url, container_name, open_mode, pinned_desktop, pinned_dock, sort_order)
                     VALUES (:uid, :aid, "docker", :title, :sub, :icon, :acc, :url, :cname, :mode, 1, 1, 210)
                     ON CONFLICT(COALESCE(user_id, 0), app_id) DO UPDATE SET
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
                    ':url'   => $targetUrl,
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
        // Reverse Proxy Caddy (/etc/caddy/conf.d/app-*.caddy)
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
            vanillia_json_error('UNKNOWN_DOCKER_ACTION', "Action Docker inconnue : {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
