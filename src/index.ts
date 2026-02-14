import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, shareContactCard, getChat, renameGroupChat } from './linq/client.js';
import { chat, getGroupChatAction, getTextForEffect } from './claude/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';
import { authRoutes, getUser, createUser, loadUserContext, generateMagicLink, buildOnboardingMessage, consumeJustOnboarded } from './auth/index.js';
import { redactPhone } from './utils/redact.js';

// Clean up LLM response formatting quirks before sending
function cleanResponse(text: string): string {
  return text
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Track message count per chat for contact card sharing
const chatMessageCount = new Map<string, number>();
const CONTACT_CARD_INTERVAL = 5; // Share every N messages

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies (cap at 50KB to prevent abuse — PEM keys are ~2KB)
app.use(express.json({ limit: '50kb' }));

// Security headers on all responses
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// HTTPS enforcement in production (behind proxy like Railway/ngrok)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      res.redirect(301, `https://${req.headers.host}${req.url}`);
      return;
    }
    next();
  });
}

// Serve static assets (fonts, images) — public/ lives at project root
app.use(express.static(path.join(process.cwd(), 'public')));

// Auth routes (onboarding page + credential submission)
app.use(authRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook endpoint for Linq Blue
app.post(
  '/webhook',
  createWebhookHandler(async (chatId, from, text, messageId, images, audio, incomingEffect, incomingReplyTo, service) => {
    const start = Date.now();
    console.log(`[main] Processing message from ${redactPhone(from)}`);

    // Track message count for this chat
    const count = (chatMessageCount.get(chatId) || 0) + 1;
    chatMessageCount.set(chatId, count);

    // Share contact card on first message or every N messages
    const shouldShareContact = count === 1 || count % CONTACT_CARD_INTERVAL === 0;

    // Mark as read, start typing, get chat info, and fetch user profile in parallel
    const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
    if (shouldShareContact) {
      console.log(`[main] Sharing contact card (message #${count})`);
      parallelTasks.push(shareContactCard(chatId));
    }
    const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
    console.log(`[timing] markAsRead+startTyping+getChat+getProfile${shouldShareContact ? '+shareContact' : ''}: ${Date.now() - start}ms`);
    if (senderProfile?.name) {
      console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
    }

    // Determine if this is a group chat (more than 2 participants)
    const isGroupChat = chatInfo.handles.length > 2;
    const participantNames = chatInfo.handles.map(h => h.handle);

    // ── Auth check: ensure user has Kalshi credentials ──────────────────
    const userCtx = loadUserContext(from);
    if (!userCtx) {
      // New user or incomplete onboarding — send magic link
      if (!getUser(from)) {
        createUser(from);
        console.log(`[main] New user: ${redactPhone(from)}`);
      } else {
        console.log(`[main] User ${redactPhone(from)} exists but no credentials`);
      }

      const magicLink = generateMagicLink(from, chatId);
      const onboardingText = buildOnboardingMessage(magicLink);

      // Split on --- and send as multiple messages (same pattern as normal responses)
      const parts = onboardingText.split('---').map(m => m.trim()).filter(m => m.length > 0);
      for (let i = 0; i < parts.length; i++) {
        await sendMessage(chatId, parts[i]);
        if (i < parts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      console.log(`[main] Sent onboarding magic link to ${redactPhone(from)}`);
      return;
    }

    // In group chats, check if Claude should respond, react, or ignore
    // Always respond to voice memos/images - someone sending media is clearly trying to communicate
    if (isGroupChat && audio.length === 0 && images.length === 0) {
      const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

      if (action === 'ignore') {
        console.log(`[main] Ignoring group chat message`);
        return;
      }

      if (action === 'react') {
        // Just send a reaction, no full response needed
        if (quickReaction) {
          await sendReaction(messageId, quickReaction);
          console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

          // Save to conversation history so Claude knows what happened (include sender for group chats)
          await addMessage(chatId, 'user', text, from);
          const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
          await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

          console.log(`[main] Reacted to ${redactPhone(from)} with ${reactionDisplay}`);
        }
        return;
      }

      console.log(`[main] Claude should respond to this group message`);
    } else if (isGroupChat) {
      console.log(`[main] Responding to group media (skipping classifier)`);
    }

    // Check if user just completed onboarding (one-shot flag)
    const justOnboarded = consumeJustOnboarded(from);
    if (justOnboarded) {
      console.log(`[main] User ${redactPhone(from)} just completed onboarding — injecting context`);
    }

    // Get Claude's response (typing indicator shows while this runs)
    const { text: responseText, reaction, effect, renameChat, rememberedUser } = await chat(chatId, text, images, audio, {
      isGroupChat,
      participantNames,
      chatName: chatInfo.display_name,
      incomingEffect,
      senderHandle: from,
      senderProfile,
      service,
      kalshiCredentials: userCtx.kalshiCredentials,
      justOnboarded,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);
    console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, effect: ${effect ? JSON.stringify(effect) : 'null'}, renameChat: ${renameChat || 'null'}`);

    // Send reaction if Claude wants to
    if (reaction) {
      await sendReaction(messageId, reaction);
      console.log(`[timing] reaction: ${Date.now() - start}ms`);
    }

    // Rename group chat if Claude wants to
    if (renameChat && isGroupChat) {
      await renameGroupChat(chatId, renameChat);
      console.log(`[timing] renameChat: ${Date.now() - start}ms`);
    }

    // Send text response if there is one (with optional effect)
    // If Claude chose an effect but no text, get text from Haiku
    let finalText = responseText;
    if (!finalText && effect) {
      console.log(`[main] Claude sent effect without text, getting message from Haiku...`);
      finalText = await getTextForEffect(effect.name);
      console.log(`[timing] effect text followup: ${Date.now() - start}ms`);
    }

    // If Claude renamed chat but didn't send text, add a simple acknowledgment (group chats only)
    if (!finalText && renameChat && isGroupChat) {
      console.log(`[main] Claude renamed chat without text, adding acknowledgment`);
      finalText = `renamed the chat to "${renameChat}" 😎`;
    }

    // If Claude used remember_user without text, just log it - no automatic acknowledgments
    // Claude should write its own response if it wants to acknowledge learning something
    if (!finalText && rememberedUser) {
      console.log(`[main] Claude saved user info without text response (no auto-ack)`);
    }

    if (finalText) {
      // Split into multiple messages first, then clean each one
      // (must split before cleaning, or the --- delimiter gets mangled)
      const messages = finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);

      // If the incoming message was a reply, continue the thread by replying to that message
      const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const isLastMessage = i === messages.length - 1;
          const messageEffect = isLastMessage ? effect ?? undefined : undefined;
          const messageReplyTo = (i === 0) ? replyTo : undefined;

          await sendMessage(chatId, messages[i], messageEffect, messageReplyTo);

          // Add a natural delay between messages (except after the last one)
          if (!isLastMessage) {
            const delay = 400 + Math.random() * 400; // 400-800ms feels natural
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        console.log(`[timing] sendMessage (${messages.length} text msg${messages.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
      }

      const extras = [effect && 'effect', replyTo && 'thread'].filter(Boolean).join(', ');
      console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
    } else if (reaction) {
      // Reaction-only response - already saved to conversation history by chat()
      console.log(`[main] Reaction-only response (saved to history for context)`);
    }

    console.log(`[main] Reply sent to ${redactPhone(from)}`);
  })
);

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║         Kai — Kalshi Trading Agent                    ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /webhook       - Linq Blue webhook receiver   ║
║    GET  /health        - Health check                 ║
║    GET  /auth/setup    - Onboarding page              ║
║                                                       ║
║  Next steps:                                          ║
║    1. Run: ngrok http ${PORT}                            ║
║    2. Configure webhook URL in Linq Blue              ║
║    3. Text your Linq Blue number!                     ║
╚═══════════════════════════════════════════════════════╝
  `);
});
