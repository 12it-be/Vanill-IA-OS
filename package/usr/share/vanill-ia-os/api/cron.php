<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Visual Cron Scheduler & Execution Telemetry API
 * Synchronizes SQLite `cron_jobs` <-> `/etc/cron.d/vanill-ia` via vanill-ia-agent
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'list'));
$pdo = vanillia_db();
$agent = new AgentClient();

/**
 * Valide la syntaxe d'une expression Cron standard (5 champs ou macro @...).
 */
function is_valid_cron_expression(string $expr): bool
{
    $expr = trim($expr);
    if (in_array($expr, ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'], true)) {
        return true;
    }
    $parts = preg_split('/\s+/', $expr) ?: [];
    if (count($parts) !== 5) {
        return false;
    }
    foreach ($parts as $part) {
        if (preg_match('#^[0-9*,/-]+$#', $part) !== 1) {
            return false;
        }
    }
    return true;
}

try {
    switch ($action) {
        case 'list':
            $user = vanillia_require_auth();
            $jobs = $pdo->query('SELECT * FROM cron_jobs ORDER BY id DESC')->fetchAll();

            $users = [['username' => 'root'], ['username' => 'www-data']];
            if ($agent->isAvailable()) {
                try {
                    $users = $agent->call('cron.users', [], 5)['users'] ?? $users;
                } catch (Throwable) {
                }
            }

            vanillia_json_success([
                'jobs'         => $jobs,
                'system_users' => $users,
                'agent_online' => $agent->isAvailable(),
            ]);

        case 'save':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();

            $id = isset($body['id']) ? (int) $body['id'] : 0;
            $title = trim((string) ($body['title'] ?? ''));
            $description = trim((string) ($body['description'] ?? ''));
            $schedule = trim((string) ($body['schedule'] ?? ''));
            $runUser = trim((string) ($body['run_user'] ?? 'root'));
            $command = trim((string) ($body['command'] ?? ''));
            $workingDir = trim((string) ($body['working_dir'] ?? '/root')) ?: '/root';
            $enabled = !empty($body['enabled']) ? 1 : 0;
            $notifyOnFail = !empty($body['notify_on_fail']) ? 1 : 0;

            if ($title === '' || strlen($title) > 120) {
                vanillia_json_error('INVALID_TITLE', 'Veuillez donner un titre clair à la tâche (max 120 caractères).');
            }
            if (!is_valid_cron_expression($schedule)) {
                vanillia_json_error('INVALID_SCHEDULE', 'Expression cron invalide (5 champs attendus ou macro @daily/@reboot...).');
            }
            if (preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $runUser) !== 1) {
                vanillia_json_error('INVALID_RUN_USER', 'Nom d\'utilisateur système invalide.');
            }
            if ($command === '') {
                vanillia_json_error('EMPTY_COMMAND', 'La commande à exécuter ne peut pas être vide.');
            }
            if (!str_starts_with($workingDir, '/')) {
                vanillia_json_error('INVALID_WORKDIR', 'Le répertoire de travail doit être un chemin absolu (ex: /root).');
            }

            $now = gmdate('Y-m-d H:i:s');
            if ($id > 0) {
                $stmt = $pdo->prepare(
                    'UPDATE cron_jobs
                     SET title = :t, description = :d, schedule = :s, run_user = :u, command = :c,
                         working_dir = :w, enabled = :e, notify_on_fail = :nf, updated_at = :up
                     WHERE id = :id'
                );
                $stmt->execute([
                    ':t'  => $title,
                    ':d'  => $description,
                    ':s'  => $schedule,
                    ':u'  => $runUser,
                    ':c'  => $command,
                    ':w'  => $workingDir,
                    ':e'  => $enabled,
                    ':nf' => $notifyOnFail,
                    ':up' => $now,
                    ':id' => $id,
                ]);
            } else {
                $stmt = $pdo->prepare(
                    'INSERT INTO cron_jobs (title, description, schedule, run_user, command, working_dir, enabled, notify_on_fail, created_at, updated_at)
                     VALUES (:t, :d, :s, :u, :c, :w, :e, :nf, :cr, :up)'
                );
                $stmt->execute([
                    ':t'  => $title,
                    ':d'  => $description,
                    ':s'  => $schedule,
                    ':u'  => $runUser,
                    ':c'  => $command,
                    ':w'  => $workingDir,
                    ':e'  => $enabled,
                    ':nf' => $notifyOnFail,
                    ':cr' => $now,
                    ':up' => $now,
                ]);
                $id = (int) $pdo->lastInsertId();
            }

            $synced = false;
            if ($agent->isAvailable()) {
                $agent->syncCronJobs();
                $synced = true;
            }

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'cron.save', (string) $id, ['title' => $title, 'schedule' => $schedule]);

            vanillia_json_success([
                'id'     => $id,
                'synced' => $synced,
                'jobs'   => $pdo->query('SELECT * FROM cron_jobs ORDER BY id DESC')->fetchAll(),
            ]);

        case 'toggle':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $id = (int) ($body['id'] ?? 0);
            $enabled = !empty($body['enabled']) ? 1 : 0;

            $pdo->prepare('UPDATE cron_jobs SET enabled = :e, updated_at = :u WHERE id = :id')
                ->execute([':e' => $enabled, ':u' => gmdate('Y-m-d H:i:s'), ':id' => $id]);

            if ($agent->isAvailable()) {
                $agent->syncCronJobs();
            }

            vanillia_json_success(['id' => $id, 'enabled' => $enabled === 1]);

        case 'delete':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $id = (int) ($body['id'] ?? 0);

            $pdo->prepare('DELETE FROM cron_jobs WHERE id = :id')->execute([':id' => $id]);
            if ($agent->isAvailable()) {
                $agent->syncCronJobs();
            }

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'cron.delete', (string) $id);
            vanillia_json_success(['deleted' => true, 'id' => $id]);

        case 'run_now':
            $user = vanillia_require_admin();
            $body = vanillia_read_body();
            $id = (int) ($body['id'] ?? 0);

            $res = $agent->call('cron.run', [
                'job_id' => $id,
                'async'  => !empty($body['async']),
            ], 125);

            vanillia_audit_log((int) $user['id'], (string) $user['username'], 'cron.run_now', (string) $id);
            vanillia_json_success($res);

        case 'logs':
            $user = vanillia_require_auth();
            $jobId = (int) ($_GET['job_id'] ?? 0);
            $stmt = $pdo->prepare('SELECT * FROM cron_logs WHERE job_id = :jid ORDER BY id DESC LIMIT 50');
            $stmt->execute([':jid' => $jobId]);

            vanillia_json_success(['logs' => $stmt->fetchAll()]);

        default:
            vanillia_json_error('UNKNOWN_CRON_ACTION', "Action Cron inconnue : {$action}", 404);
    }
} catch (AgentClientException $e) {
    vanillia_json_error($e->errorCode, $e->getMessage(), $e->httpStatus);
}
