import type { User, KalshiCredentials, AuthToken } from './types.js';
import { encrypt, decrypt } from './encryption.js';
import { redactPhone } from '../utils/redact.js';

// In-memory storage (swap for a DB later — same interface)
const users = new Map<string, User>();
const credentials = new Map<string, string>(); // phoneNumber → encrypted string
const authTokens = new Map<string, AuthToken>(); // token → AuthToken
const recentlyOnboarded = new Set<string>(); // phone numbers that just completed onboarding

// ── Users ──────────────────────────────────────────────────────────────────

export function getUser(phoneNumber: string): User | null {
  return users.get(phoneNumber) ?? null;
}

export function createUser(phoneNumber: string): User {
  const user: User = {
    phoneNumber,
    createdAt: new Date(),
    lastActive: new Date(),
    onboardingComplete: false,
  };
  users.set(phoneNumber, user);
  console.log(`[auth] Created user: ${redactPhone(phoneNumber)}`);
  return user;
}

export function updateLastActive(phoneNumber: string): void {
  const user = users.get(phoneNumber);
  if (user) user.lastActive = new Date();
}

// ── Credentials ────────────────────────────────────────────────────────────

export function getCredentials(phoneNumber: string): KalshiCredentials | null {
  const encrypted = credentials.get(phoneNumber);
  if (!encrypted) return null;
  try {
    return decrypt(encrypted) as KalshiCredentials;
  } catch (err) {
    console.error(`[auth] Failed to decrypt credentials for ${redactPhone(phoneNumber)}:`, err);
    return null;
  }
}

export function setCredentials(phoneNumber: string, creds: KalshiCredentials): void {
  const encrypted = encrypt(creds);
  credentials.set(phoneNumber, encrypted);

  // Mark onboarding complete and flag as recently onboarded
  const user = users.get(phoneNumber);
  if (user) user.onboardingComplete = true;
  recentlyOnboarded.add(phoneNumber);

  console.log(`[auth] Stored encrypted credentials for ${redactPhone(phoneNumber)}`);
}

/**
 * Check if user just completed onboarding (one-shot: returns true once, then clears).
 */
export function consumeJustOnboarded(phoneNumber: string): boolean {
  if (recentlyOnboarded.has(phoneNumber)) {
    recentlyOnboarded.delete(phoneNumber);
    return true;
  }
  return false;
}

// ── Auth Tokens (magic links) ──────────────────────────────────────────────

export function createAuthToken(phoneNumber: string, chatId: string, token: string, ttlMinutes: number = 15): AuthToken {
  const now = new Date();
  const authToken: AuthToken = {
    token,
    phoneNumber,
    chatId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
    used: false,
  };
  authTokens.set(token, authToken);
  console.log(`[auth] Created auth token for ${redactPhone(phoneNumber)} (expires in ${ttlMinutes}m)`);
  return authToken;
}

export function verifyAuthToken(token: string): string | null {
  const authToken = authTokens.get(token);
  if (!authToken) return null;
  if (authToken.used) return null;
  if (new Date() > authToken.expiresAt) return null;
  return authToken.phoneNumber;
}

export function getAuthTokenChatId(token: string): string | null {
  const authToken = authTokens.get(token);
  if (!authToken) return null;
  return authToken.chatId;
}

export function markAuthTokenUsed(token: string): void {
  const authToken = authTokens.get(token);
  if (authToken) authToken.used = true;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Purge expired and used auth tokens from memory.
 * Runs automatically every 10 minutes.
 */
function purgeExpiredTokens(): void {
  const now = new Date();
  let purged = 0;
  for (const [token, authToken] of authTokens) {
    // Remove tokens that are expired OR used (no reason to keep them)
    if (authToken.used || now > authToken.expiresAt) {
      authTokens.delete(token);
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[auth] Purged ${purged} expired/used auth tokens (${authTokens.size} remaining)`);
  }
}

// Run cleanup every 10 minutes
setInterval(purgeExpiredTokens, 10 * 60_000);
