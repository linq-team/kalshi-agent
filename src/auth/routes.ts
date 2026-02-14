import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { verifyAuthToken, getAuthTokenChatId } from './db.js';
import { verifyMagicLinkToken } from './magicLink.js';
import { setCredentials, createUser, getUser } from './db.js';
import { sendMessage } from '../linq/client.js';
import { KalshiClient } from '../kalshi/index.js';
import { redactPhone } from '../utils/redact.js';

export const authRoutes = Router();

// ── Rate Limiting ──────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_SUBMIT = 5;     // 5 attempts per minute per IP
const RATE_LIMIT_MAX_PAGE = 15;      // 15 page loads per minute per IP

function rateLimit(max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      next();
      return;
    }

    entry.count++;
    if (entry.count > max) {
      console.warn(`[auth] Rate limit hit: ${ip} on ${req.path} (${entry.count}/${max})`);
      res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
      return;
    }

    next();
  };
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60_000);

// ── Input Validation ───────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidApiKeyId(id: string): boolean {
  return UUID_REGEX.test(id.trim());
}

function isValidPem(pem: string): boolean {
  const trimmed = pem.trim();
  // Must start and end with PEM markers
  if (!trimmed.startsWith('-----BEGIN') || !trimmed.includes('-----END')) {
    return false;
  }
  // Reasonable size bounds (RSA 2048 = ~1.7KB, RSA 4096 = ~3.2KB)
  if (trimmed.length < 500 || trimmed.length > 10_000) {
    return false;
  }
  // Try to parse it as a crypto key to fully validate
  try {
    crypto.createPrivateKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

// Sanitize token for safe HTML embedding (prevent XSS via token parameter)
function sanitizeForHtml(str: string): string {
  return str.replace(/[&<>"'`/\\]/g, '');
}


// CSP header for onboarding pages
function setPageSecurityHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'unsafe-inline'",  // inline JS for the form handler
    "style-src 'unsafe-inline'",   // inline styles
    "img-src 'self' https://img.logo.dev",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
}

/**
 * GET /auth/setup?token={token}
 * Verify the magic link token and serve the onboarding page.
 */
authRoutes.get('/auth/setup', rateLimit(RATE_LIMIT_MAX_PAGE), (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    setPageSecurityHeaders(res);
    res.status(400).send(errorPage('Missing token', 'This link is invalid. Ask Kai for a new one.'));
    return;
  }

  // Verify token is valid (but don't burn it yet — burn on submit)
  const phoneNumber = verifyAuthToken(token);
  if (!phoneNumber) {
    setPageSecurityHeaders(res);
    res.status(400).send(errorPage('Link expired', 'This link has expired or already been used. Text Kai to get a new one.'));
    return;
  }

  setPageSecurityHeaders(res);
  res.send(onboardingPage(sanitizeForHtml(token)));
});

/**
 * POST /auth/setup/submit
 * Receive API credentials, encrypt and store them.
 */
authRoutes.post('/auth/setup/submit', rateLimit(RATE_LIMIT_MAX_SUBMIT), async (req, res) => {
  // CSRF defense: verify the request originated from our own page
  const origin = req.get('Origin') || req.get('Referer') || '';
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (origin && !origin.startsWith(baseUrl)) {
    console.warn(`[auth] Blocked cross-origin submit from: ${origin}`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { token, apiKeyId, privateKeyPem } = req.body as {
    token?: string;
    apiKeyId?: string;
    privateKeyPem?: string;
  };

  if (!token || !apiKeyId || !privateKeyPem) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  // Validate input formats before doing anything else
  if (!isValidApiKeyId(apiKeyId)) {
    res.status(400).json({ error: 'Invalid API Key ID format. It should be a UUID (e.g., d08833d3-a08f-423f-b6ba-0bfffb4a5df5).' });
    return;
  }

  if (!isValidPem(privateKeyPem)) {
    res.status(400).json({ error: 'Invalid private key. Make sure you uploaded the correct .pem file from Kalshi.' });
    return;
  }

  // Grab the chatId before burning the token (needed to send welcome message)
  const chatId = getAuthTokenChatId(token);

  // Verify and burn the token
  const phoneNumber = verifyMagicLinkToken(token);
  if (!phoneNumber) {
    res.status(400).json({ error: 'Invalid or expired token. Text Kai for a new link.' });
    return;
  }

  // Validate credentials against Kalshi API before storing
  const trimmedKeyId = apiKeyId.trim();
  const trimmedPem = privateKeyPem.trim();
  try {
    const testClient = new KalshiClient({
      apiKeyId: trimmedKeyId,
      privateKey: trimmedPem,
    });
    await testClient.getBalance();
    console.log(`[auth] Kalshi credentials verified for ${redactPhone(phoneNumber)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[auth] Kalshi credential validation failed for ${redactPhone(phoneNumber)}:`, msg);
    res.status(400).json({ error: 'Could not authenticate with Kalshi. Double-check your API Key ID and private key file.' });
    return;
  }

  // Ensure user exists
  if (!getUser(phoneNumber)) {
    createUser(phoneNumber);
  }

  // Store encrypted credentials (validated ✓)
  setCredentials(phoneNumber, {
    apiKeyId: trimmedKeyId,
    privateKeyPem: trimmedPem,
  });

  console.log(`[auth] Credentials saved for ${redactPhone(phoneNumber)}`);
  res.json({ success: true });

  // Send welcome message in the background (don't block the response)
  if (chatId) {
    sendMessage(chatId, `you're all set! your kalshi account is connected 🎉`)
      .then(() => {
        const delay = 800 + Math.random() * 400;
        return new Promise(resolve => setTimeout(resolve, delay));
      })
      .then(() => sendMessage(chatId, `i can search markets, check what's trending, place trades, track your portfolio — just text me what you need`))
      .then(() => console.log(`[auth] Welcome messages sent to ${redactPhone(phoneNumber)}`))
      .catch(err => console.error(`[auth] Failed to send welcome message:`, err));
  }
});

// ── HTML Templates ─────────────────────────────────────────────────────────

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kai — ${title}</title>
  <link rel="icon" href="/favicon.ico">
  <style>${baseStyles()}
    .error-wrap {
      text-align: center;
      padding: 60px 28px;
    }
    .error-wrap h1 {
      font-size: 24px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    ${headerHTML()}
    <div class="card">
      <div class="error-wrap">
        <h1>${title}</h1>
        <p class="muted">${message}</p>
      </div>
    </div>
    ${footerHTML()}
  </div>
</body>
</html>`;
}

function onboardingPage(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kai — Authenticate your Account</title>
  <link rel="icon" href="/favicon.ico">
  <meta property="og:title" content="Connect your Kalshi account">
  <meta property="og:description" content="Tap to link your Kalshi account with Kai — takes 30 seconds">
  <meta property="og:image" content="${process.env.BASE_URL || ''}/images/og-image.png">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Connect your Kalshi account">
  <meta name="twitter:description" content="Tap to link your Kalshi account with Kai — takes 30 seconds">
  <style>${baseStyles()}
    .security-banner {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      background: rgba(200, 255, 0, 0.04);
      border: 1px solid rgba(200, 255, 0, 0.12);
      border-radius: 12px;
      padding: 16px 18px;
      margin-bottom: 24px;
    }
    .lock-icon {
      width: 20px;
      height: 20px;
      color: #c8ff00;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .security-text {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .security-title {
      font-size: 13px;
      font-weight: 600;
      color: #c8ff00;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .security-detail {
      font-size: 12px;
      color: #a1a1a1;
      line-height: 1.5;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .security-note {
      font-size: 11px;
      color: #6b6b6b;
      line-height: 1.5;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .security-note svg {
      display: inline-block;
      vertical-align: -1px;
      margin-right: 4px;
      color: #6b6b6b;
    }
    .security-note a {
      color: #c8ff00;
      text-decoration: none;
    }
    .security-note a:hover {
      text-decoration: underline;
    }
    .steps {
      text-align: left;
      background: #111111;
      border: 1px solid #222222;
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 28px;
      font-size: 14px;
      line-height: 2;
      color: #a1a1a1;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .steps strong { color: #ffffff; }
    .steps a { color: #c8ff00; text-decoration: none; }
    .steps a:hover { text-decoration: underline; }
    form { display: flex; flex-direction: column; gap: 24px; }
    .field { text-align: left; }
    .field label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      color: #6b6b6b;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    input {
      width: 100%;
      padding: 14px 16px;
      background: #111111;
      border: 1px solid #222222;
      border-radius: 10px;
      color: #ffffff;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
      box-sizing: border-box;
    }
    input::placeholder { color: #333333; }
    input:focus { border-color: #c8ff00; }

    /* File upload drop zone */
    .file-drop {
      position: relative;
      width: 100%;
      min-height: 120px;
      background: #111111;
      border: 1px dashed #222222;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      padding: 24px 16px;
    }
    .file-drop:hover, .file-drop.dragover {
      border-color: #c8ff00;
      background: rgba(200, 255, 0, 0.03);
    }
    .file-drop.has-file {
      border-style: solid;
      border-color: #c8ff00;
      background: rgba(200, 255, 0, 0.05);
    }
    .file-drop input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      background: none;
      border: none;
      padding: 0;
    }
    .file-drop .upload-icon {
      width: 32px;
      height: 32px;
      color: #333333;
      transition: color 0.2s;
    }
    .file-drop:hover .upload-icon,
    .file-drop.dragover .upload-icon {
      color: #c8ff00;
    }
    .file-drop.has-file .upload-icon { color: #c8ff00; }
    .file-drop .upload-text {
      font-size: 13px;
      color: #6b6b6b;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .file-drop.has-file .upload-text { color: #c8ff00; }
    .file-drop .upload-hint {
      font-size: 11px;
      color: #333333;
      font-family: system-ui, -apple-system, sans-serif;
    }

    button[type="submit"] {
      padding: 16px;
      background: #c8ff00;
      color: #0a0a0a;
      border: none;
      border-radius: 100px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
      margin-top: 4px;
      font-family: 'FK Display', system-ui, -apple-system, sans-serif;
      letter-spacing: 0.2px;
    }
    button[type="submit"]:hover { background: #b8ef00; }
    button[type="submit"]:active { transform: scale(0.98); }
    button[type="submit"]:disabled {
      background: #222222;
      color: #6b6b6b;
      cursor: not-allowed;
      transform: none;
    }

    .success {
      display: none;
      text-align: center;
      padding: 48px 0;
    }
    .success .check {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgba(200, 255, 0, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .success .check svg { width: 28px; height: 28px; }
    .success h2 {
      color: #ffffff;
      font-size: 22px;
      font-weight: 400;
      margin: 0 0 8px;
      font-family: 'FK Display', system-ui, sans-serif;
    }
    .success p {
      color: #a1a1a1;
      margin: 0;
      font-size: 15px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .error-msg {
      color: #ff4444;
      font-size: 13px;
      display: none;
      text-align: left;
      font-family: system-ui, -apple-system, sans-serif;
    }
  </style>
</head>
<body>
  <div class="container">
    ${headerHTML()}

    <div class="card">
      <div class="card-content">
        <div class="title-section">
          <h1>Authenticate your Account</h1>
          <p class="muted">Link your Kalshi API key so Kai can trade on your behalf</p>
        </div>

        <div class="security-banner">
          <svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <div class="security-text">
            <span class="security-title">End-to-end encrypted</span>
            <span class="security-detail">Your key is encrypted with AES-256-GCM before storage. We never see your Kalshi password — only an API key you create.</span>
          </div>
        </div>

        <div class="steps">
          <strong>How to get your API key:</strong><br>
          1. Go to <a href="https://kalshi.com/account/profile" target="_blank">kalshi.com/account/profile</a><br>
          2. Scroll to the <strong>API Keys</strong> section<br>
          3. Click <strong>Create New API Key</strong><br>
          4. Save the <strong>Private Key</strong> file that downloads — you won't be able to retrieve it again<br>
          5. Copy the <strong>Key ID</strong> and upload the private key file below
        </div>

        <div id="form-section">
          <form id="setup-form" onsubmit="return handleSubmit(event)">
            <div class="field">
              <label for="apiKeyId">API Key ID</label>
              <input type="text" id="apiKeyId" name="apiKeyId" placeholder="d08833d3-a08f-423f-b6ba-0bfffb4a5df5" required>
            </div>
            <div class="field">
              <label>Private Key (.pem file)</label>
              <div class="file-drop" id="file-drop">
                <input type="file" id="pemFile" accept=".pem,.key,.txt" />
                <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                <span class="upload-text" id="upload-text">Drop your .pem file here or tap to upload</span>
                <span class="upload-hint" id="upload-hint">RSA Private Key file from Kalshi</span>
              </div>
            </div>
            <p class="error-msg" id="error-msg"></p>
            <p class="security-note">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              Your key is encrypted at rest and transmitted over HTTPS. You can revoke it anytime from <a href="https://kalshi.com/account/profile" target="_blank">kalshi.com</a>.
            </p>
            <button type="submit" id="submit-btn">Authenticate</button>
          </form>
        </div>

        <div class="success" id="success-section">
          <div class="check">
            <svg viewBox="0 0 24 24" fill="none" stroke="#c8ff00" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <h2>You're all set</h2>
          <p>Go back to iMessage and start trading with Kai</p>
        </div>
      </div>
    </div>

    ${footerHTML()}
  </div>

  <script>
    let pemContent = '';

    // File drop zone interactions
    const dropZone = document.getElementById('file-drop');
    const fileInput = document.getElementById('pemFile');
    const uploadText = document.getElementById('upload-text');
    const uploadHint = document.getElementById('upload-hint');

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) handleFile(file);
    });

    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        pemContent = e.target.result;
        dropZone.classList.add('has-file');
        uploadText.textContent = file.name;
        uploadHint.textContent = 'File loaded — ready to authenticate';
      };
      reader.readAsText(file);
    }

    async function handleSubmit(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      const errorEl = document.getElementById('error-msg');
      errorEl.style.display = 'none';

      const apiKeyId = document.getElementById('apiKeyId').value.trim();

      if (!apiKeyId) {
        errorEl.textContent = 'Please enter your API Key ID';
        errorEl.style.display = 'block';
        return false;
      }

      if (!pemContent) {
        errorEl.textContent = 'Please upload your private key .pem file';
        errorEl.style.display = 'block';
        return false;
      }

      btn.disabled = true;
      btn.textContent = 'Connecting...';

      try {
        const res = await fetch('/auth/setup/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: '${token}',
            apiKeyId: apiKeyId,
            privateKeyPem: pemContent.trim(),
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Something went wrong');
        }

        document.getElementById('form-section').style.display = 'none';
        document.getElementById('success-section').style.display = 'block';
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Authenticate';
      }
      return false;
    }
  </script>
</body>
</html>`;
}

function headerHTML(): string {
  return `
    <div class="header-bar">
      <div class="logo-row">
        <img src="/images/linq-header-white.png" alt="Linq" class="linq-wordmark">
        <span class="logo-x">x</span>
        <img src="https://img.logo.dev/kalshi.com?token=pk_c2nKhfMyRIOeCjrk-6-RRw" alt="Kalshi" class="kalshi-logo">
      </div>
    </div>`;
}

function footerHTML(): string {
  return `
    <p class="footer-text">
      Built on <a href="https://linqapp.com" target="_blank" class="accent-link">Linq</a>
    </p>
    <p class="disclaimer">Not associated with or endorsed by Kalshi, Inc.</p>`;
}

function baseStyles(): string {
  return `
    @font-face {
      font-family: 'FK Display';
      src: url('/fonts/FKDisplay-Regular.ttf') format('truetype');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'FK Display Alt';
      src: url('/fonts/FKDisplay-RegularAlt.ttf') format('truetype');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'FK Display', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 0 20px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 560px;
      width: 100%;
    }

    /* ── Header: Linq x Kalshi ── */
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px 0;
      border-bottom: 1px solid #222222;
      margin-bottom: 36px;
    }
    .logo-row {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .linq-wordmark {
      height: 30px;
      width: auto;
    }
    .logo-x {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 400;
      color: #6b6b6b;
      user-select: none;
    }
    .kalshi-logo {
      height: 30px;
      width: auto;
      border-radius: 4px;
    }

    /* ── Card ── */
    .card {
      background: #111111;
      border: 1px solid #222222;
      border-radius: 16px;
      overflow: hidden;
    }
    .card-content {
      padding: 36px 32px;
    }

    .title-section {
      margin-bottom: 28px;
    }
    h1 {
      font-family: 'FK Display', system-ui, sans-serif;
      font-size: 24px;
      font-weight: 400;
      margin-bottom: 8px;
      color: #ffffff;
      letter-spacing: -0.3px;
    }
    .muted {
      color: #a1a1a1;
      font-size: 15px;
      line-height: 1.5;
      font-family: system-ui, -apple-system, sans-serif;
    }

    /* ── Footer ── */
    .accent { color: #c8ff00; }
    .accent-link { color: #c8ff00; text-decoration: none; }
    .accent-link:hover { text-decoration: underline; }
    .footer-text {
      text-align: center;
      color: #6b6b6b;
      font-size: 13px;
      padding: 24px 0 8px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .disclaimer {
      text-align: center;
      color: #333333;
      font-size: 11px;
      padding: 0 0 40px;
      font-family: system-ui, -apple-system, sans-serif;
    }
  `;
}
