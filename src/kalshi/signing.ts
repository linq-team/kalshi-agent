/**
 * Kalshi RSA-PSS Request Signing
 *
 * Algorithm:
 *   1. Build message string: `${timestampMs}${METHOD}${pathWithPrefix}`
 *      - timestampMs: current time in MILLISECONDS as a string (e.g. "1703123456789")
 *      - METHOD: uppercase HTTP method (GET, POST, DELETE, etc.)
 *      - pathWithPrefix: MUST include /trade-api/v2 prefix (e.g. "/trade-api/v2/portfolio/balance")
 *      - Query parameters are STRIPPED from the path before signing
 *   2. Sign with RSA-PSS:
 *      - Hash: SHA-256
 *      - MGF: MGF1 with SHA-256
 *      - Salt length: digest length (32 bytes for SHA-256)
 *   3. Base64-encode the signature
 *   4. Send three headers:
 *      - KALSHI-ACCESS-KEY: your API key ID (UUID)
 *      - KALSHI-ACCESS-TIMESTAMP: the same millisecond timestamp string
 *      - KALSHI-ACCESS-SIGNATURE: the base64-encoded signature
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

export interface KalshiCredentials {
  apiKeyId: string;
  privateKey: crypto.KeyObject;
}

/**
 * Load RSA private key from a PEM file on disk.
 */
export function loadPrivateKeyFromFile(filePath: string): crypto.KeyObject {
  const pem = fs.readFileSync(filePath, 'utf-8');
  return crypto.createPrivateKey(pem);
}

/**
 * Load RSA private key from a PEM string (e.g. from an environment variable).
 */
export function loadPrivateKeyFromString(pem: string): crypto.KeyObject {
  return crypto.createPrivateKey(pem);
}

/**
 * Strip query parameters from a path.
 * "/trade-api/v2/portfolio/orders?limit=5" -> "/trade-api/v2/portfolio/orders"
 */
function stripQueryParams(path: string): string {
  const idx = path.indexOf('?');
  return idx === -1 ? path : path.substring(0, idx);
}

/**
 * Sign a Kalshi API request and return the three auth headers.
 *
 * @param credentials  - API key ID + loaded RSA private key
 * @param method       - HTTP method in uppercase (GET, POST, etc.)
 * @param path         - Full path INCLUDING /trade-api/v2 prefix; query params OK (will be stripped)
 * @param timestampMs  - Optional; defaults to Date.now(). Millisecond timestamp.
 */
export function signRequest(
  credentials: KalshiCredentials,
  method: string,
  path: string,
  timestampMs?: number,
): { headers: Record<string, string>; timestamp: string } {
  const ts = String(timestampMs ?? Date.now());
  const cleanPath = stripQueryParams(path);
  const message = `${ts}${method.toUpperCase()}${cleanPath}`;

  const signature = crypto.sign('sha256', Buffer.from(message, 'utf-8'), {
    key: credentials.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST, // = hash digest length = 32
  });

  return {
    timestamp: ts,
    headers: {
      'KALSHI-ACCESS-KEY': credentials.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    },
  };
}
