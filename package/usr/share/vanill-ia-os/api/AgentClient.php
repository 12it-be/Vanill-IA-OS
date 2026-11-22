<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Privileged Unix Socket Client (AgentClient)
 * ==============================================================================
 * Used exclusively by unprivileged PHP-FPM API controllers (www-data) to send
 * validated JSON commands over /run/vanill-ia/agent.sock to vanill-ia-agent.
 * ==============================================================================
 */

final class AgentClientException extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $httpStatus = 500,
        ?Throwable $previous = null
    ) {
        parent::__construct($message, $httpStatus, $previous);
    }
}

final class AgentClient
{
    public const DEFAULT_SOCKET_PATH = '/run/vanill-ia/agent.sock';

    public function __construct(
        private readonly string $socketPath = self::DEFAULT_SOCKET_PATH,
        private readonly int $defaultTimeoutSeconds = 15
    ) {
    }

    /**
     * Vérifie rapidement si le socket du daemon système est présent et accessible.
     */
    public function isAvailable(): bool
    {
        return file_exists($this->socketPath) && is_writable($this->socketPath);
    }

    /**
     * Envoie une commande atomique au daemon vanill-ia-agent et retourne `data`.
     *
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     * @throws AgentClientException
     */
    public function call(string $action, array $params = [], ?int $timeoutSeconds = null): array
    {
        $response = $this->callRaw($action, $params, $timeoutSeconds);

        if (($response['ok'] ?? false) !== true) {
            $err = is_array($response['error'] ?? null) ? $response['error'] : [];
            $code = (string) ($err['code'] ?? 'AGENT_ERROR');
            $message = (string) ($err['message'] ?? 'Erreur renvoyée par le daemon vanill-ia-agent.');
            $httpStatus = isset($err['http_status']) ? (int) $err['http_status'] : 400;
            throw new AgentClientException($code, $message, $httpStatus);
        }

        return is_array($response['data'] ?? null) ? $response['data'] : [];
    }

    /**
     * Retourne l'enveloppe complète (incluant `meta.duration_ms` et `id`).
     *
     * @param array<string, mixed> $params
     * @return array<string, mixed>
     * @throws AgentClientException
     */
    public function callRaw(string $action, array $params = [], ?int $timeoutSeconds = null): array
    {
        if (!file_exists($this->socketPath)) {
            throw new AgentClientException(
                'AGENT_OFFLINE',
                'Le service système vanill-ia-agent ne répond pas (socket introuvable : ' . $this->socketPath . ').',
                503
            );
        }

        $timeout = max(2, $timeoutSeconds ?? $this->defaultTimeoutSeconds);
        $requestId = bin2hex(random_bytes(6));

        $payload = json_encode([
            'id'     => $requestId,
            'action' => $action,
            'params' => (object) $params,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($payload === false) {
            throw new AgentClientException('ENCODE_ERROR', 'Impossible de sérialiser la requête JSON.', 500);
        }

        $errno = 0;
        $errstr = '';
        $stream = @stream_socket_client(
            'unix://' . $this->socketPath,
            $errno,
            $errstr,
            5.0
        );

        if ($stream === false) {
            throw new AgentClientException(
                'SOCKET_CONNECT_FAILED',
                sprintf('Connexion refusée sur %s : [%d] %s', $this->socketPath, $errno, $errstr),
                503
            );
        }

        try {
            stream_set_timeout($stream, $timeout);

            $frame = $payload . "\n";
            $length = strlen($frame);
            $written = 0;

            while ($written < $length) {
                $bytes = @fwrite($stream, substr($frame, $written));
                if ($bytes === false || $bytes === 0) {
                    throw new AgentClientException('SOCKET_WRITE_FAILED', 'Échec d\'écriture vers le daemon système.', 502);
                }
                $written += $bytes;
            }

            $rawResponse = fgets($stream);
            $meta = stream_get_meta_data($stream);

            if (!empty($meta['timed_out'])) {
                throw new AgentClientException(
                    'AGENT_TIMEOUT',
                    sprintf('Le daemon système n\'a pas répondu dans le délai imparti (%ds) pour [%s].', $timeout, $action),
                    504
                );
            }

            if ($rawResponse === false || trim($rawResponse) === '') {
                throw new AgentClientException('EMPTY_RESPONSE', 'Réponse vide reçue du daemon système.', 502);
            }

            try {
                $decoded = json_decode($rawResponse, true, 64, JSON_THROW_ON_ERROR);
            } catch (JsonException $e) {
                throw new AgentClientException('INVALID_AGENT_JSON', 'Réponse JSON invalide reçue du daemon : ' . $e->getMessage(), 502, $e);
            }

            if (!is_array($decoded)) {
                throw new AgentClientException('INVALID_AGENT_PAYLOAD', 'Structure de réponse inattendue du daemon.', 502);
            }

            return $decoded;
        } finally {
            @fclose($stream);
        }
    }

    // --------------------------------------------------------------------------
    // Méthodes utilitaires typées pour les contrôleurs API Web
    // --------------------------------------------------------------------------

    /** @return array<string, mixed> */
    public function ping(): array
    {
        return $this->call('agent.ping', [], 3);
    }

    /** @return array<string, mixed> */
    public function getSystemInfo(): array
    {
        return $this->call('system.info', [], 8);
    }

    /** @return array<string, mixed> */
    public function getSystemMetrics(): array
    {
        return $this->call('system.metrics', [], 6);
    }

    /** @return array<string, mixed> */
    public function getDockerContainers(bool $all = true): array
    {
        return $this->call('docker.containers', ['all' => $all], 12);
    }

    /** @return array<string, mixed> */
    public function syncCronJobs(): array
    {
        return $this->call('cron.sync', [], 10);
    }
}
