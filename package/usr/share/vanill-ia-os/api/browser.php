<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Remote Browser Isolation API (/api/browser.php)
 * Controls ephemeral TigerVNC + Openbox + Chromium + noVNC session on demand
 * via `vanill-ia-agent` (`browser_start`, `browser_stop`, `browser_status`).
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'status'));
$agent = new AgentClient();

try {
    switch ($action) {
        case 'status':
            $user = vanillia_require_auth();
            if (!$agent->isAvailable()) {
                vanillia_json_success([
                    'agent_online'     => false,
                    'running'          => false,
                    'novnc_ready'      => false,
                    'ram_mb'           => 0,
                    'missing_packages' => '',
                    'missing_list'     => [],
                ]);
            }

            $res = $agent->call('browser_status', [], 10);
            $res['agent_online'] = true;
            vanillia_json_success($res);

        case 'start':
            $user = vanillia_require_auth();
            $body = vanillia_read_body();
            $targetUrl = isset($body['url']) && is_string($body['url']) ? trim($body['url']) : '';
            $params = [];
            if ($targetUrl !== '') {
                $scheme = strtolower((string) parse_url($targetUrl, PHP_URL_SCHEME));
                if (filter_var($targetUrl, FILTER_VALIDATE_URL) !== false && in_array($scheme, ['http', 'https'], true)) {
                    $params['url'] = $targetUrl;
                }
            }
            $res = $agent->call('browser_start', $params, 35);
            $res['agent_online'] = true;
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'browser.start', $params['url'] ?? null);
            vanillia_json_success($res);

        case 'stop':
            $user = vanillia_require_auth();
            if ($agent->isAvailable()) {
                $res = $agent->call('browser_stop', [], 20);
            } else {
                $res = ['running' => false, 'ram_mb' => 0];
            }
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'browser.stop');
            vanillia_json_success($res);

        case 'reset':
            $user = vanillia_require_auth();
            $agent->call('browser_stop', [], 20);
            $res = $agent->call('browser_start', [], 35);
            $res['agent_online'] = true;
            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'browser.reset');
            vanillia_json_success($res);

        default:
            vanillia_json_error('UNKNOWN_BROWSER_ACTION', "Unknown browser action: {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
