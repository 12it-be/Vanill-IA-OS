<?php

declare(strict_types=1);

/**
 * ==============================================================================
 * Vanill-IA OS — Native TOTP 2FA Engine (RFC 6238 / RFC 4226)
 * Zero external dependencies — Compatible with Aegis, Bitwarden, Proton, Google Auth
 * ==============================================================================
 */

final class Totp
{
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    private const PERIOD = 30;
    private const DIGITS = 6;

    /**
     * Génère un secret aléatoire Base32 de 160 bits (32 caractères Base32).
     */
    public static function generateSecret(int $byteLength = 20): string
    {
        $bytes = random_bytes(max(16, $byteLength));
        return self::base32Encode($bytes);
    }

    /**
     * Calcule le code TOTP à 6 chiffres pour un horodatage donné.
     */
    public static function getCode(string $base32Secret, ?int $timestamp = null): string
    {
        $secretKey = self::base32Decode($base32Secret);
        if ($secretKey === '') {
            throw new InvalidArgumentException('Secret TOTP Base32 invalide.');
        }

        $timeSlice = intdiv($timestamp ?? time(), self::PERIOD);
        // Pack 64-bit big-endian counter
        $binaryTime = pack('N*', 0) . pack('N*', $timeSlice);
        $hash = hash_hmac('sha1', $binaryTime, $secretKey, true);

        $offset = ord($hash[19]) & 0x0F;
        $truncated = (
            ((ord($hash[$offset]) & 0x7F) << 24) |
            ((ord($hash[$offset + 1]) & 0xFF) << 16) |
            ((ord($hash[$offset + 2]) & 0xFF) << 8) |
            (ord($hash[$offset + 3]) & 0xFF)
        );

        $otp = $truncated % (10 ** self::DIGITS);
        return str_pad((string) $otp, self::DIGITS, '0', STR_PAD_LEFT);
    }

    /**
     * Vérifie un code à 6 chiffres avec tolérance de dérive d'horloge (±1 tranche de 30s).
     */
    public static function verify(string $base32Secret, string $userCode, int $discrepancy = 1, ?int $timestamp = null): bool
    {
        $cleanCode = preg_replace('/\s+|-/', '', trim($userCode)) ?? '';
        if (preg_match('/^\d{6}$/', $cleanCode) !== 1) {
            return false;
        }

        $now = $timestamp ?? time();
        for ($i = -$discrepancy; $i <= $discrepancy; $i++) {
            $expected = self::getCode($base32Secret, $now + ($i * self::PERIOD));
            if (hash_equals($expected, $cleanCode)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Construit l'URI standard otpauth:// pour génération du QR Code local.
     */
    public static function buildOtpAuthUri(string $username, string $base32Secret, string $issuer = 'Vanill-IA OS'): string
    {
        $label = rawurlencode($issuer . ':' . $username);
        $params = http_build_query([
            'secret'    => strtoupper($base32Secret),
            'issuer'    => $issuer,
            'algorithm' => 'SHA1',
            'digits'    => self::DIGITS,
            'period'    => self::PERIOD,
        ], '', '&', PHP_QUERY_RFC3986);

        return "otpauth://totp/{$label}?{$params}";
    }

    /**
     * Génère un jeu de codes de secours à usage unique (format XXXX-XXXX).
     *
     * @return list<string>
     */
    public static function generateBackupCodes(int $count = 8): array
    {
        $codes = [];
        for ($i = 0; $i < $count; $i++) {
            $raw = strtoupper(bin2hex(random_bytes(4)));
            $codes[] = substr($raw, 0, 4) . '-' . substr($raw, 4, 4);
        }
        return $codes;
    }

    public static function base32Encode(string $data): string
    {
        if ($data === '') {
            return '';
        }

        $binary = '';
        $len = strlen($data);
        for ($i = 0; $i < $len; $i++) {
            $binary .= str_pad(decbin(ord($data[$i])), 8, '0', STR_PAD_LEFT);
        }

        $chunks = str_split($binary, 5);
        $output = '';
        foreach ($chunks as $chunk) {
            if (strlen($chunk) < 5) {
                $chunk = str_pad($chunk, 5, '0', STR_PAD_RIGHT);
            }
            $output .= self::ALPHABET[bindec($chunk)];
        }

        return $output;
    }

    public static function base32Decode(string $input): string
    {
        $clean = strtoupper(preg_replace('/[^A-Za-z2-7]/', '', $input) ?? '');
        if ($clean === '') {
            return '';
        }

        $binary = '';
        $len = strlen($clean);
        for ($i = 0; $i < $len; $i++) {
            $pos = strpos(self::ALPHABET, $clean[$i]);
            if ($pos === false) {
                return '';
            }
            $binary .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
        }

        $bytes = str_split($binary, 8);
        $output = '';
        foreach ($bytes as $byte) {
            if (strlen($byte) === 8) {
                $output .= chr((int) bindec($byte));
            }
        }

        return $output;
    }
}
