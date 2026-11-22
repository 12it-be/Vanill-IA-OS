<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Native AI Layer & SysAdmin Diagnostic Engine (api/ai.php)
 * - Full Admin Control: ZERO arbitrary clamping on context_window, max_output_tokens,
 *   temperature, top_p, top_k, reasoning_effort, extra_headers or extra_body.
 * - Default Engine: Google Gemini 3.8 Flash (`gemini-3.8-flash`, 1M ctx, 65k out,
 *   Vision + Reasoning + Tools) + Ollama Local + OpenRouter + OpenAI + Anthropic.
 * - API Keys encrypted at rest via `vanillia_encrypt()` (Sodium XSalsa20-Poly1305).
 * ==============================================================================
 */

require_once __DIR__ . '/bootstrap.php';

$action = trim((string) ($_GET['action'] ?? 'bootstrap'));
$pdo = vanillia_db();
$agent = new AgentClient();

/**
 * Formate une configuration moteur IA pour le frontend (masque la clé API brute).
 *
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function format_ai_config_public(array $row): array
{
    $plainKey = vanillia_decrypt((string) ($row['api_key'] ?? ''));
    $masked = $plainKey !== ''
        ? substr($plainKey, 0, 4) . str_repeat('•', max(4, min(16, strlen($plainKey) - 8))) . substr($plainKey, -4)
        : '';

    return [
        'id'                 => (int) $row['id'],
        'slug'               => (string) $row['slug'],
        'name'               => (string) $row['name'],
        'provider_type'      => (string) $row['provider_type'],
        'base_url'           => (string) $row['base_url'],
        'has_api_key'        => $plainKey !== '',
        'api_key_masked'     => $masked,
        'model_id'           => (string) $row['model_id'],
        'context_window'     => (int) $row['context_window'],
        'max_output_tokens'  => (int) $row['max_output_tokens'],
        'temperature'        => $row['temperature'] !== null ? (float) $row['temperature'] : null,
        'top_p'              => $row['top_p'] !== null ? (float) $row['top_p'] : null,
        'top_k'              => $row['top_k'] !== null ? (int) $row['top_k'] : null,
        'reasoning_effort'   => $row['reasoning_effort'],
        'supports_vision'    => ((int) $row['supports_vision']) === 1,
        'supports_reasoning' => ((int) $row['supports_reasoning']) === 1,
        'supports_tools'     => ((int) $row['supports_tools']) === 1,
        'system_prompt'      => (string) $row['system_prompt'],
        'extra_headers_json' => (string) $row['extra_headers_json'],
        'extra_body_json'    => (string) $row['extra_body_json'],
        'timeout_seconds'    => (int) $row['timeout_seconds'],
        'is_default'         => ((int) $row['is_default']) === 1,
        'enabled'            => ((int) $row['enabled']) === 1,
    ];
}

/**
 * Construit un résumé live de l'état Debian pour enrichir le diagnostic SysAdmin.
 */
function build_live_sysadmin_context(AgentClient $agent): string
{
    if (!$agent->isAvailable()) {
        return "Contexte Hôte : Environnement Vanill-IA OS (daemon local hors-ligne).";
    }

    try {
        $info = $agent->getSystemInfo();
        $metrics = $agent->getSystemMetrics();
        $cpu = $metrics['cpu']['total_percent'] ?? 0;
        $ramPct = $metrics['memory']['used_percent'] ?? 0;

        return sprintf(
            "Contexte Serveur Actuel : %s (%s, Kernel %s, %s) | CPU: %s%% | RAM: %s%% | Docker actif: %s",
            $info['hostname'] ?? 'debian',
            $info['os_name'] ?? 'Debian',
            $info['kernel'] ?? '',
            $info['arch'] ?? 'amd64',
            (string) $cpu,
            (string) $ramPct,
            !empty($info['docker_ready']) ? 'oui' : 'non'
        );
    } catch (Throwable) {
        return '';
    }
}

/**
 * Appel HTTP universel vers le fournisseur IA choisi sans aucun bridage des paramètres.
 *
 * @param array<string, mixed> $cfg
 * @param list<array<string, mixed>> $messages
 * @param array{mime_type: string, base64: string}|null $imageAttachment
 * @return array{content: string, reasoning: ?string, tokens_in: ?int, tokens_out: ?int}
 */
function dispatch_llm_completion(array $cfg, string $systemInstruction, array $messages, ?array $imageAttachment = null): array
{
    $provider = (string) $cfg['provider_type'];
    $baseUrl = rtrim((string) $cfg['base_url'], '/');
    $apiKey = vanillia_decrypt((string) ($cfg['api_key'] ?? ''));
    $model = (string) $cfg['model_id'];
    $timeout = max(10, (int) ($cfg['timeout_seconds'] ?? 120));

    $extraHeaders = json_decode((string) ($cfg['extra_headers_json'] ?? '{}'), true);
    $extraBody = json_decode((string) ($cfg['extra_body_json'] ?? '{}'), true);
    if (!is_array($extraHeaders)) {
        $extraHeaders = [];
    }
    if (!is_array($extraBody)) {
        $extraBody = [];
    }

    // --------------------------------------------------------------------------
    // A. GOOGLE GEMINI NATIVE API (generateContent — ex: gemini-3.8-flash)
    // --------------------------------------------------------------------------
    if ($provider === 'gemini') {
        if ($apiKey === '') {
            vanillia_json_error('MISSING_API_KEY', 'Veuillez renseigner votre clé API Google Gemini dans les paramètres moteurs de Vanill-IA.');
        }

        $url = "{$baseUrl}/models/" . rawurlencode($model) . ':generateContent?key=' . rawurlencode($apiKey);
        $contents = [];
        $lastIdx = count($messages) - 1;

        foreach ($messages as $idx => $m) {
            if ($m['role'] === 'system') {
                continue;
            }
            $parts = [['text' => (string) $m['content']]];
            if ($idx === $lastIdx && $imageAttachment !== null && !empty($cfg['supports_vision'])) {
                $parts[] = [
                    'inline_data' => [
                        'mime_type' => $imageAttachment['mime_type'],
                        'data'      => $imageAttachment['base64'],
                    ],
                ];
            }
            $contents[] = [
                'role'  => $m['role'] === 'assistant' ? 'model' : 'user',
                'parts' => $parts,
            ];
        }

        $genConfig = [
            'maxOutputTokens' => (int) $cfg['max_output_tokens'],
        ];
        if ($cfg['temperature'] !== null && $cfg['temperature'] !== '') {
            $genConfig['temperature'] = (float) $cfg['temperature'];
        }
        if ($cfg['top_p'] !== null && $cfg['top_p'] !== '') {
            $genConfig['topP'] = (float) $cfg['top_p'];
        }
        if ($cfg['top_k'] !== null && $cfg['top_k'] !== '') {
            $genConfig['topK'] = (int) $cfg['top_k'];
        }

        $payload = array_replace_recursive([
            'systemInstruction' => [
                'parts' => [['text' => $systemInstruction]],
            ],
            'contents'         => $contents,
            'generationConfig' => $genConfig,
        ], $extraBody);

        $res = execute_json_curl($url, $payload, $extraHeaders, $timeout);
        $partsOut = $res['candidates'][0]['content']['parts'] ?? [];
        $text = '';
        $reasoning = '';

        foreach ($partsOut as $p) {
            if (!empty($p['thought']) && isset($p['text'])) {
                $reasoning .= $p['text'];
            } elseif (isset($p['text'])) {
                $text .= $p['text'];
            }
        }

        if ($text === '' && isset($res['error']['message'])) {
            vanillia_json_error('GEMINI_API_ERROR', (string) $res['error']['message'], 502);
        }

        return [
            'content'    => $text !== '' ? $text : '(Réponse vide du modèle)',
            'reasoning'  => $reasoning !== '' ? $reasoning : null,
            'tokens_in'  => isset($res['usageMetadata']['promptTokenCount']) ? (int) $res['usageMetadata']['promptTokenCount'] : null,
            'tokens_out' => isset($res['usageMetadata']['candidatesTokenCount']) ? (int) $res['usageMetadata']['candidatesTokenCount'] : null,
        ];
    }

    // --------------------------------------------------------------------------
    // B. OLLAMA LOCAL NATIVE API (/api/chat)
    // --------------------------------------------------------------------------
    if ($provider === 'ollama') {
        $url = "{$baseUrl}/api/chat";
        $ollamaMsgs = [['role' => 'system', 'content' => $systemInstruction]];
        $lastIdx = count($messages) - 1;

        foreach ($messages as $idx => $m) {
            $item = [
                'role'    => $m['role'],
                'content' => (string) $m['content'],
            ];
            if ($idx === $lastIdx && $imageAttachment !== null && !empty($cfg['supports_vision'])) {
                $item['images'] = [$imageAttachment['base64']];
            }
            $ollamaMsgs[] = $item;
        }

        $options = [
            'num_ctx'     => (int) $cfg['context_window'],
            'num_predict' => (int) $cfg['max_output_tokens'],
        ];
        if ($cfg['temperature'] !== null && $cfg['temperature'] !== '') {
            $options['temperature'] = (float) $cfg['temperature'];
        }
        if ($cfg['top_p'] !== null && $cfg['top_p'] !== '') {
            $options['top_p'] = (float) $cfg['top_p'];
        }
        if ($cfg['top_k'] !== null && $cfg['top_k'] !== '') {
            $options['top_k'] = (int) $cfg['top_k'];
        }

        $headers = $extraHeaders;
        if ($apiKey !== '') {
            $headers['Authorization'] = "Bearer {$apiKey}";
        }

        $payload = array_replace_recursive([
            'model'    => $model,
            'messages' => $ollamaMsgs,
            'stream'   => false,
            'options'  => $options,
        ], $extraBody);

        $res = execute_json_curl($url, $payload, $headers, $timeout);
        if (isset($res['error'])) {
            vanillia_json_error('OLLAMA_ERROR', is_string($res['error']) ? $res['error'] : json_encode($res['error']), 502);
        }

        return [
            'content'    => (string) ($res['message']['content'] ?? ''),
            'reasoning'  => isset($res['message']['thinking']) ? (string) $res['message']['thinking'] : null,
            'tokens_in'  => isset($res['prompt_eval_count']) ? (int) $res['prompt_eval_count'] : null,
            'tokens_out' => isset($res['eval_count']) ? (int) $res['eval_count'] : null,
        ];
    }

    // --------------------------------------------------------------------------
    // C. ANTHROPIC MESSAGES API (/v1/messages)
    // --------------------------------------------------------------------------
    if ($provider === 'anthropic') {
        if ($apiKey === '') {
            vanillia_json_error('MISSING_API_KEY', 'Clé API Anthropic manquante.');
        }

        $url = str_ends_with($baseUrl, '/messages') ? $baseUrl : "{$baseUrl}/messages";
        $headers = array_merge([
            'x-api-key'         => $apiKey,
            'anthropic-version' => '2023-06-01',
        ], $extraHeaders);

        $anthMsgs = [];
        foreach ($messages as $m) {
            if ($m['role'] === 'system') {
                continue;
            }
            $anthMsgs[] = ['role' => $m['role'], 'content' => (string) $m['content']];
        }

        $payload = array_replace_recursive([
            'model'      => $model,
            'system'     => $systemInstruction,
            'max_tokens' => (int) $cfg['max_output_tokens'],
            'messages'   => $anthMsgs,
        ], $extraBody);

        if ($cfg['temperature'] !== null && $cfg['temperature'] !== '') {
            $payload['temperature'] = (float) $cfg['temperature'];
        }

        $res = execute_json_curl($url, $payload, $headers, $timeout);
        if (isset($res['error']['message'])) {
            vanillia_json_error('ANTHROPIC_ERROR', (string) $res['error']['message'], 502);
        }

        $text = '';
        $reasoning = '';
        foreach (($res['content'] ?? []) as $blk) {
            if (($blk['type'] ?? '') === 'thinking') {
                $reasoning .= (string) ($blk['thinking'] ?? '');
            } elseif (($blk['type'] ?? '') === 'text') {
                $text .= (string) ($blk['text'] ?? '');
            }
        }

        return [
            'content'    => $text,
            'reasoning'  => $reasoning !== '' ? $reasoning : null,
            'tokens_in'  => isset($res['usage']['input_tokens']) ? (int) $res['usage']['input_tokens'] : null,
            'tokens_out' => isset($res['usage']['output_tokens']) ? (int) $res['usage']['output_tokens'] : null,
        ];
    }

    // --------------------------------------------------------------------------
    // D. OPENAI / OPENROUTER / COMPATIBLE API (/chat/completions)
    // --------------------------------------------------------------------------
    if ($apiKey === '' && in_array($provider, ['openai', 'openrouter'], true)) {
        vanillia_json_error('MISSING_API_KEY', "Clé API requise pour {$cfg['name']}.");
    }

    $url = str_ends_with($baseUrl, '/chat/completions') ? $baseUrl : "{$baseUrl}/chat/completions";
    $headers = $extraHeaders;
    if ($apiKey !== '') {
        $headers['Authorization'] = "Bearer {$apiKey}";
    }
    if ($provider === 'openrouter') {
        $headers['HTTP-Referer'] = 'https://gitea.jn-dev.be/JN/Vanill-IA-OS';
        $headers['X-Title'] = 'Vanill-IA OS';
    }

    $oaMsgs = [['role' => 'system', 'content' => $systemInstruction]];
    $lastIdx = count($messages) - 1;
    foreach ($messages as $idx => $m) {
        if ($m['role'] === 'system') {
            continue;
        }
        if ($idx === $lastIdx && $imageAttachment !== null && !empty($cfg['supports_vision'])) {
            $oaMsgs[] = [
                'role'    => $m['role'],
                'content' => [
                    ['type' => 'text', 'text' => (string) $m['content']],
                    ['type' => 'image_url', 'image_url' => ['url' => "data:{$imageAttachment['mime_type']};base64,{$imageAttachment['base64']}"]],
                ],
            ];
        } else {
            $oaMsgs[] = ['role' => $m['role'], 'content' => (string) $m['content']];
        }
    }

    $payload = [
        'model'      => $model,
        'messages'   => $oaMsgs,
        'max_tokens' => (int) $cfg['max_output_tokens'],
    ];
    if ($cfg['temperature'] !== null && $cfg['temperature'] !== '') {
        $payload['temperature'] = (float) $cfg['temperature'];
    }
    if ($cfg['top_p'] !== null && $cfg['top_p'] !== '') {
        $payload['top_p'] = (float) $cfg['top_p'];
    }
    if (!empty($cfg['reasoning_effort'])) {
        $payload['reasoning_effort'] = (string) $cfg['reasoning_effort'];
    }

    $payload = array_replace_recursive($payload, $extraBody);
    $res = execute_json_curl($url, $payload, $headers, $timeout);

    if (isset($res['error']['message'])) {
        vanillia_json_error('LLM_API_ERROR', (string) $res['error']['message'], 502);
    }

    $choiceMsg = $res['choices'][0]['message'] ?? [];
    return [
        'content'    => (string) ($choiceMsg['content'] ?? ''),
        'reasoning'  => isset($choiceMsg['reasoning_content']) ? (string) $choiceMsg['reasoning_content'] : (isset($choiceMsg['reasoning']) ? (string) $choiceMsg['reasoning'] : null),
        'tokens_in'  => isset($res['usage']['prompt_tokens']) ? (int) $res['usage']['prompt_tokens'] : null,
        'tokens_out' => isset($res['usage']['completion_tokens']) ? (int) $res['usage']['completion_tokens'] : null,
    ];
}

/**
 * Exécute une requête HTTP POST JSON via cURL.
 *
 * @param array<string, mixed> $payload
 * @param array<string, string> $headersAssoc
 * @return array<string, mixed>
 */
function execute_json_curl(string $url, array $payload, array $headersAssoc, int $timeoutSec): array
{
    $ch = curl_init($url);
    if ($ch === false) {
        vanillia_json_error('CURL_ERROR', 'Impossible d\'initialiser cURL.', 500);
    }

    $headers = [
        'Content-Type: application/json',
        'Accept: application/json',
    ];
    foreach ($headersAssoc as $k => $v) {
        $headers[] = "{$k}: {$v}";
    }

    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeoutSec,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);

    $raw = curl_exec($ch);
    $err = curl_error($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false) {
        vanillia_json_error('LLM_NETWORK_ERROR', "Connexion impossible au moteur IA ({$url}) : {$err}", 502);
    }

    $decoded = json_decode((string) $raw, true);
    if (!is_array($decoded)) {
        vanillia_json_error('LLM_INVALID_JSON', "Réponse non-JSON reçue du moteur IA (HTTP {$httpCode}).", 502);
    }

    return $decoded;
}

switch ($action) {
    // --------------------------------------------------------------------------
    // Initialisation du client Chat : Moteurs + Conversations récentes
    // --------------------------------------------------------------------------
    case 'bootstrap':
        $user = vanillia_require_auth();
        $configsRows = $pdo->query('SELECT * FROM ai_configs ORDER BY is_default DESC, id ASC')->fetchAll();
        $configs = array_map('format_ai_config_public', $configsRows);

        $convStmt = $pdo->prepare('SELECT * FROM ai_conversations WHERE user_id IS NULL OR user_id = :uid ORDER BY updated_at DESC, id DESC LIMIT 40');
        $convStmt->execute([':uid' => (int) $user['id']]);

        vanillia_json_success([
            'configs'       => $configs,
            'conversations' => $convStmt->fetchAll(),
            'auto_context'  => vanillia_get_setting('ai.sysadmin_auto_context', '1') === '1',
        ]);

    case 'conversation_get':
        $user = vanillia_require_auth();
        $convId = (int) ($_GET['id'] ?? 0);
        $stmt = $pdo->prepare('SELECT * FROM ai_conversations WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $convId]);
        $conv = $stmt->fetch();

        if ($conv === false) {
            vanillia_json_error('CONV_NOT_FOUND', 'Conversation introuvable.', 404);
        }

        $msgStmt = $pdo->prepare('SELECT * FROM ai_messages WHERE conversation_id = :cid ORDER BY id ASC');
        $msgStmt->execute([':cid' => $convId]);

        vanillia_json_success([
            'conversation' => $conv,
            'messages'     => $msgStmt->fetchAll(),
        ]);

    case 'conversation_delete':
        $user = vanillia_require_auth();
        $body = vanillia_read_body();
        $convId = (int) ($body['id'] ?? 0);
        $pdo->prepare('DELETE FROM ai_conversations WHERE id = :id')->execute([':id' => $convId]);
        vanillia_json_success(['deleted' => true]);

    // --------------------------------------------------------------------------
    // Envoi d'un message Chat ou Diagnostic SysAdmin Contextuel
    // --------------------------------------------------------------------------
    case 'chat':
        $user = vanillia_require_auth();
        $body = vanillia_read_body();

        $configId = (int) ($body['config_id'] ?? 0);
        $conversationId = (int) ($body['conversation_id'] ?? 0);
        $prompt = trim((string) ($body['message'] ?? ''));
        $contextType = in_array($body['context_type'] ?? '', ['chat', 'docker_diag', 'systemd_diag', 'cron_diag', 'security_diag'], true)
            ? (string) $body['context_type']
            : 'chat';
        $contextTarget = isset($body['context_target']) ? trim((string) $body['context_target']) : null;

        if ($prompt === '') {
            vanillia_json_error('EMPTY_PROMPT', 'Message vide.');
        }

        if ($configId > 0) {
            $cStmt = $pdo->prepare('SELECT * FROM ai_configs WHERE id = :id LIMIT 1');
            $cStmt->execute([':id' => $configId]);
            $cfg = $cStmt->fetch();
        } else {
            $cfg = $pdo->query('SELECT * FROM ai_configs WHERE enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1')->fetch();
        }

        if ($cfg === false) {
            vanillia_json_error('NO_AI_ENGINE', 'Aucun moteur IA actif configuré.');
        }

        $now = gmdate('Y-m-d H:i:s');
        if ($conversationId <= 0) {
            $title = $contextTarget
                ? "[Diag] {$contextTarget}"
                : mb_substr(preg_replace('/\s+/', ' ', $prompt) ?? 'Discussion', 0, 52);
            $insConv = $pdo->prepare(
                'INSERT INTO ai_conversations (user_id, ai_config_id, title, context_type, context_target, created_at, updated_at)
                 VALUES (:uid, :cid, :t, :ct, :ctg, :c, :u)'
            );
            $insConv->execute([
                ':uid' => (int) $user['id'],
                ':cid' => (int) $cfg['id'],
                ':t'   => $title,
                ':ct'  => $contextType,
                ':ctg' => $contextTarget,
                ':c'   => $now,
                ':u'   => $now,
            ]);
            $conversationId = (int) $pdo->lastInsertId();
        }

        // Sauvegarde du message utilisateur
        $insMsg = $pdo->prepare(
            'INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (:cid, "user", :cnt, :ts)'
        );
        $insMsg->execute([
            ':cid' => $conversationId,
            ':cnt' => $prompt,
            ':ts'  => $now,
        ]);

        $historyStmt = $pdo->prepare('SELECT role, content FROM ai_messages WHERE conversation_id = :cid ORDER BY id ASC');
        $historyStmt->execute([':cid' => $conversationId]);
        $history = $historyStmt->fetchAll();

        $sysPrompt = (string) $cfg['system_prompt'];
        if (vanillia_get_setting('ai.sysadmin_auto_context', '1') === '1') {
            $liveCtx = build_live_sysadmin_context($agent);
            if ($liveCtx !== '') {
                $sysPrompt .= "\n\n" . $liveCtx;
            }
        }

        $imageAttach = null;
        if (!empty($body['image_base64']) && is_string($body['image_base64'])) {
            $imageAttach = [
                'mime_type' => (string) ($body['image_mime'] ?? 'image/png'),
                'base64'    => $body['image_base64'],
            ];
        }

        $startNs = hrtime(true);
        $llmRes = dispatch_llm_completion($cfg, $sysPrompt, $history, $imageAttach);
        $durationMs = (int) round((hrtime(true) - $startNs) / 1_000_000);
        $replyTs = gmdate('Y-m-d H:i:s');

        $insReply = $pdo->prepare(
            'INSERT INTO ai_messages (conversation_id, role, content, reasoning_text, tokens_input, tokens_output, duration_ms, created_at)
             VALUES (:cid, "assistant", :cnt, :rsn, :tin, :tout, :dur, :ts)'
        );
        $insReply->execute([
            ':cid'  => $conversationId,
            ':cnt'  => $llmRes['content'],
            ':rsn'  => $llmRes['reasoning'],
            ':tin'  => $llmRes['tokens_in'],
            ':tout' => $llmRes['tokens_out'],
            ':dur'  => $durationMs,
            ':ts'   => $replyTs,
        ]);
        $replyId = (int) $pdo->lastInsertId();

        $pdo->prepare('UPDATE ai_conversations SET ai_config_id = :aid, updated_at = :u WHERE id = :id')
            ->execute([':aid' => (int) $cfg['id'], ':u' => $replyTs, ':id' => $conversationId]);

        vanillia_json_success([
            'conversation_id' => $conversationId,
            'assistant'       => [
                'id'             => $replyId,
                'role'           => 'assistant',
                'content'        => $llmRes['content'],
                'reasoning_text' => $llmRes['reasoning'],
                'tokens_input'   => $llmRes['tokens_in'],
                'tokens_output'  => $llmRes['tokens_out'],
                'duration_ms'    => $durationMs,
                'created_at'     => $replyTs,
            ],
        ]);

    // --------------------------------------------------------------------------
    // Administration Complète des Moteurs IA (Zéro bridage des paramètres !)
    // --------------------------------------------------------------------------
    case 'config_save':
        $user = vanillia_require_admin();
        $body = vanillia_read_body();

        $id = isset($body['id']) ? (int) $body['id'] : 0;
        $name = trim((string) ($body['name'] ?? ''));
        $provider = trim((string) ($body['provider_type'] ?? 'custom_openai'));
        $baseUrl = trim((string) ($body['base_url'] ?? ''));
        $modelId = trim((string) ($body['model_id'] ?? ''));

        if ($name === '' || $baseUrl === '' || $modelId === '') {
            vanillia_json_error('INVALID_AI_CONFIG', 'Nom, URL de base et ID du modèle sont requis.');
        }
        if (!in_array($provider, ['ollama', 'gemini', 'openai', 'openrouter', 'anthropic', 'custom_openai'], true)) {
            vanillia_json_error('INVALID_PROVIDER', 'Type de fournisseur IA inconnu.');
        }

        // Aucun plafonnement arbitraire : l'admin choisit librement ses fenêtres de contexte et tokens de sortie
        $ctxWindow = max(1, (int) ($body['context_window'] ?? 1048576));
        $maxOut = max(1, (int) ($body['max_output_tokens'] ?? 65536));
        $temp = ($body['temperature'] ?? '') !== '' ? (float) $body['temperature'] : null;
        $topP = ($body['top_p'] ?? '') !== '' ? (float) $body['top_p'] : null;
        $topK = ($body['top_k'] ?? '') !== '' ? (int) $body['top_k'] : null;
        $reasoningEffort = !empty($body['reasoning_effort']) ? trim((string) $body['reasoning_effort']) : null;
        $supportsVision = !empty($body['supports_vision']) ? 1 : 0;
        $supportsReasoning = !empty($body['supports_reasoning']) ? 1 : 0;
        $supportsTools = !empty($body['supports_tools']) ? 1 : 0;
        $sysPrompt = (string) ($body['system_prompt'] ?? '');
        $extraHeaders = trim((string) ($body['extra_headers_json'] ?? '{}')) ?: '{}';
        $extraBody = trim((string) ($body['extra_body_json'] ?? '{}')) ?: '{}';
        $timeoutSec = max(5, (int) ($body['timeout_seconds'] ?? 120));
        $isDefault = !empty($body['is_default']) ? 1 : 0;
        $enabled = ($body['enabled'] ?? true) ? 1 : 0;

        if (json_decode($extraHeaders, true) === null && $extraHeaders !== '{}') {
            vanillia_json_error('INVALID_HEADERS_JSON', 'Le champ JSON des en-têtes additionnels est invalide.');
        }
        if (json_decode($extraBody, true) === null && $extraBody !== '{}') {
            vanillia_json_error('INVALID_BODY_JSON', 'Le champ JSON des paramètres additionnels est invalide.');
        }

        if ($isDefault === 1) {
            $pdo->exec('UPDATE ai_configs SET is_default = 0');
        }

        $now = gmdate('Y-m-d H:i:s');
        $rawApiKey = isset($body['api_key']) ? trim((string) $body['api_key']) : '';

        if ($id > 0) {
            $existingStmt = $pdo->prepare('SELECT api_key FROM ai_configs WHERE id = :id LIMIT 1');
            $existingStmt->execute([':id' => $id]);
            $prevKey = (string) ($existingStmt->fetchColumn() ?: '');
            $encryptedKey = $rawApiKey === '__CLEAR__'
                ? ''
                : ($rawApiKey !== '' ? vanillia_encrypt($rawApiKey) : $prevKey);

            $stmt = $pdo->prepare(
                'UPDATE ai_configs
                 SET name = :n, provider_type = :pt, base_url = :bu, api_key = :ak, model_id = :mid,
                     context_window = :cw, max_output_tokens = :mo, temperature = :tmp, top_p = :tp, top_k = :tk,
                     reasoning_effort = :re, supports_vision = :sv, supports_reasoning = :sr, supports_tools = :st,
                     system_prompt = :sp, extra_headers_json = :eh, extra_body_json = :eb, timeout_seconds = :to,
                     is_default = :def, enabled = :en, updated_at = :up
                 WHERE id = :id'
            );
            $stmt->execute([
                ':n'   => $name,
                ':pt'  => $provider,
                ':bu'  => $baseUrl,
                ':ak'  => $encryptedKey,
                ':mid' => $modelId,
                ':cw'  => $ctxWindow,
                ':mo'  => $maxOut,
                ':tmp' => $temp,
                ':tp'  => $topP,
                ':tk'  => $topK,
                ':re'  => $reasoningEffort,
                ':sv'  => $supportsVision,
                ':sr'  => $supportsReasoning,
                ':st'  => $supportsTools,
                ':sp'  => $sysPrompt,
                ':eh'  => $extraHeaders,
                ':eb'  => $extraBody,
                ':to'  => $timeoutSec,
                ':def' => $isDefault,
                ':en'  => $enabled,
                ':up'  => $now,
                ':id'  => $id,
            ]);
        } else {
            $slug = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $name) ?: 'engine') . '-' . substr(bin2hex(random_bytes(2)), 0, 4);
            $encryptedKey = ($rawApiKey !== '' && $rawApiKey !== '__CLEAR__') ? vanillia_encrypt($rawApiKey) : '';

            $stmt = $pdo->prepare(
                'INSERT INTO ai_configs
                    (slug, name, provider_type, base_url, api_key, model_id, context_window, max_output_tokens,
                     temperature, top_p, top_k, reasoning_effort, supports_vision, supports_reasoning, supports_tools,
                     system_prompt, extra_headers_json, extra_body_json, timeout_seconds, is_default, enabled, created_at, updated_at)
                 VALUES
                    (:sl, :n, :pt, :bu, :ak, :mid, :cw, :mo, :tmp, :tp, :tk, :re, :sv, :sr, :st, :sp, :eh, :eb, :to, :def, :en, :cr, :up)'
            );
            $stmt->execute([
                ':sl'  => $slug,
                ':n'   => $name,
                ':pt'  => $provider,
                ':bu'  => $baseUrl,
                ':ak'  => $encryptedKey,
                ':mid' => $modelId,
                ':cw'  => $ctxWindow,
                ':mo'  => $maxOut,
                ':tmp' => $temp,
                ':tp'  => $topP,
                ':tk'  => $topK,
                ':re'  => $reasoningEffort,
                ':sv'  => $supportsVision,
                ':sr'  => $supportsReasoning,
                ':st'  => $supportsTools,
                ':sp'  => $sysPrompt,
                ':eh'  => $extraHeaders,
                ':eb'  => $extraBody,
                ':to'  => $timeoutSec,
                ':def' => $isDefault,
                ':en'  => $enabled,
                ':cr'  => $now,
                ':up'  => $now,
            ]);
        }

        if (isset($body['auto_context'])) {
            vanillia_set_setting('ai.sysadmin_auto_context', !empty($body['auto_context']) ? '1' : '0', 'ai');
        }

        vanillia_audit_log((int) $user['id'], (string) $user['username'], 'ai.config_save', $name);
        $rows = $pdo->query('SELECT * FROM ai_configs ORDER BY is_default DESC, id ASC')->fetchAll();
        vanillia_json_success(['configs' => array_map('format_ai_config_public', $rows)]);

    case 'config_delete':
        $user = vanillia_require_admin();
        $body = vanillia_read_body();
        $id = (int) ($body['id'] ?? 0);
        $pdo->prepare('DELETE FROM ai_configs WHERE id = :id')->execute([':id' => $id]);
        $rows = $pdo->query('SELECT * FROM ai_configs ORDER BY is_default DESC, id ASC')->fetchAll();
        vanillia_json_success(['configs' => array_map('format_ai_config_public', $rows)]);

    // --------------------------------------------------------------------------
    // Découverte dynamique des modèles disponibles (ex: Ollama /api/tags)
    // --------------------------------------------------------------------------
    case 'discover_models':
        $user = vanillia_require_admin();
        $body = vanillia_read_body();
        $provider = (string) ($body['provider_type'] ?? 'ollama');
        $baseUrl = rtrim((string) ($body['base_url'] ?? 'http://127.0.0.1:11434'), '/');

        $url = $provider === 'ollama' ? "{$baseUrl}/api/tags" : "{$baseUrl}/models";
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 8,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);

        if ($raw === false) {
            vanillia_json_error('DISCOVERY_FAILED', "Impossible d'interroger {$url}.", 502);
        }

        $json = json_decode((string) $raw, true) ?: [];
        $models = [];
        if ($provider === 'ollama' && isset($json['models']) && is_array($json['models'])) {
            foreach ($json['models'] as $m) {
                if (!empty($m['name'])) {
                    $models[] = (string) $m['name'];
                }
            }
        } elseif (isset($json['data']) && is_array($json['data'])) {
            foreach ($json['data'] as $m) {
                if (!empty($m['id'])) {
                    $models[] = (string) $m['id'];
                }
            }
        }

        vanillia_json_success(['models' => $models]);

    default:
        vanillia_json_error('UNKNOWN_AI_ACTION', "Action IA inconnue : {$action}", 404);
}
