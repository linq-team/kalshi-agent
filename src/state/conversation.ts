// In-memory conversation and user profile storage
// Conversations expire after 1 hour. User profiles persist until process restarts.

const CONVERSATION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_MESSAGES = 20;

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string;
}

interface ConversationRecord {
  messages: StoredMessage[];
  lastActive: number;
}

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number;
  lastSeen: number;
}

const conversations = new Map<string, ConversationRecord>();
const userProfiles = new Map<string, UserProfile>();

// Clean up expired conversations periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of conversations) {
    if (now - record.lastActive > CONVERSATION_TTL_MS) {
      conversations.delete(key);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  const record = conversations.get(chatId);
  if (!record) return [];
  if (Date.now() - record.lastActive > CONVERSATION_TTL_MS) {
    conversations.delete(chatId);
    return [];
  }
  return [...record.messages];
}

export async function addMessage(chatId: string, role: 'user' | 'assistant', content: string, handle?: string): Promise<void> {
  const record = conversations.get(chatId) || { messages: [], lastActive: Date.now() };
  const msg: StoredMessage = { role, content };
  if (handle) msg.handle = handle;
  record.messages.push(msg);
  record.messages = record.messages.slice(-MAX_MESSAGES);
  record.lastActive = Date.now();
  conversations.set(chatId, record);
}

export async function clearConversation(chatId: string): Promise<void> {
  conversations.delete(chatId);
}

export async function clearAllConversations(): Promise<void> {
  conversations.clear();
}

// ── User Profiles ───────────────────────────────────────────────────────────

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  return userProfiles.get(handle) || null;
}

export async function updateUserProfile(handle: string, updates: { name?: string; facts?: string[] }): Promise<void> {
  const existing = userProfiles.get(handle);
  const now = Math.floor(Date.now() / 1000);
  const profile: UserProfile = {
    handle,
    name: updates.name ?? existing?.name ?? null,
    facts: updates.facts ?? existing?.facts ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  userProfiles.set(handle, profile);
  console.log(`[state] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  const existing = userProfiles.get(handle);
  const facts = existing?.facts ? [...existing.facts] : [];
  if (facts.includes(fact)) return false;
  facts.push(fact);
  await updateUserProfile(handle, { facts });
  return true;
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  const existing = userProfiles.get(handle);
  if (existing?.name === name) return false;
  await updateUserProfile(handle, { name });
  return true;
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  userProfiles.delete(handle);
  console.log(`[state] Cleared profile for ${handle}`);
  return true;
}
