import type { User, KalshiCredentials } from './types.js';
import { getUser, getCredentials, updateLastActive } from './db.js';

export interface UserContext {
  user: User;
  kalshiCredentials: KalshiCredentials;
}

/**
 * Load a user's context (user record + decrypted Kalshi credentials).
 * Returns null if the user doesn't exist or hasn't completed onboarding.
 */
export function loadUserContext(phoneNumber: string): UserContext | null {
  const user = getUser(phoneNumber);
  if (!user) return null;

  const creds = getCredentials(phoneNumber);
  if (!creds) return null;

  updateLastActive(phoneNumber);
  return { user, kalshiCredentials: creds };
}
