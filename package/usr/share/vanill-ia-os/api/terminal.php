<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Web Terminal Backend (Debian Host Shell & Docker Exec)
 * Supports stateful working directory (`cwd`) + optional ttyd detection
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$user = vanillia_require_admin();
$action = trim((string) ($_GET['action'] ?? 'exec'));
$agent = new AgentClient();

try {
    switch ($action) {
        case 'init':
            $containers = [];
            if ($agent->isAvailable()) {
                try {
                    $all = $agent->call('docker.containers', ['all' => false], 8)['containers'] ?? [];
                    foreach ($all as $c) {
                        $containers[] = ['id' => $c['id'], 'name' => $c['name'], 'image' => $c['image']];
                    }
                } catch (Throwable) {
                }
                $probe = $agent->call('shell.exec', ['command' => '', 'cwd' => '/root'], 6);
                vanillia_json_success([
                    'agent_online' => true,
                    'cwd'          => $probe['cwd'] ?? '/root',
                    'hostname'     => $probe['hostname'] ?? (gethostname() ?: 'debian'),
                    'ttyd_open'    => !empty($probe['ttyd_open']),
                    'containers'   => $containers,
                ]);
            }

            vanillia_json_success([
                'agent_online' => false,
                'cwd'          => '/root',
                'hostname'     => gethostname() ?: 'debian',
                'ttyd_open'    => false,
                'containers'   => [],
            ]);

        case 'exec':
            $body = vanillia_read_body();
            $target = trim((string) ($body['target'] ?? 'host'));
            $command = trim((string) ($body['command'] ?? ''));
            $cwd = trim((string) ($body['cwd'] ?? '/root')) ?: '/root';

            if ($target !== 'host') {
                $res = $agent->call('docker.container.exec', [
                    'id'      => $target,
                    'command' => $command,
                ], 40);
                vanillia_audit_log((int) $user['id'], (string) $user['username'], 'terminal.docker_exec', $target, ['cmd' => $command]);
                vanillia_json_success([
                    'exit_code' => $res['exit_code'],
                    'stdout'    => $res['stdout'],
                    'stderr'    => $res['stderr'],
                    'cwd'       => '/',
                ]);
            }

            $res = $agent->call('shell.exec', [
                'command' => $command,
                'cwd'     => $cwd,
            ], 65);
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'terminal.host_exec', $cwd, ['cmd' => $command]);
            vanillia_json_success($res);

        default:
            vanillia_json_error('UNKNOWN_TERMINAL_ACTION', "Action terminal inconnue : {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
