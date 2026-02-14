import Anthropic from '@anthropic-ai/sdk';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';
import { KalshiClient } from '../kalshi/index.js';
import type { KalshiCredentials } from '../auth/types.js';

const client = new Anthropic();

// Derive Kalshi web URL from event_ticker (e.g. "KXGREENLAND-29" → "kalshi.com/markets/kxgreenland")
function kalshiUrl(eventTicker: string): string {
  const series = eventTicker.replace(/-\d.*$/, '').toLowerCase();
  return `https://kalshi.com/markets/${series}`;
}

// Shared/default Kalshi client for public data (trending, search) — uses env vars if available
const defaultKalshi = (process.env.KALSHI_API_KEY_ID && process.env.KALSHI_PRIVATE_KEY_PATH)
  ? new KalshiClient({
      apiKeyId: process.env.KALSHI_API_KEY_ID,
      privateKey: process.env.KALSHI_PRIVATE_KEY_PATH,
    })
  : null;

/**
 * Create a KalshiClient from per-user credentials.
 */
function createUserKalshiClient(creds: KalshiCredentials): KalshiClient {
  return new KalshiClient({
    apiKeyId: creds.apiKeyId,
    privateKey: creds.privateKeyPem, // PEM string — client auto-detects
  });
}

const SYSTEM_PROMPT = `You are Kai, an AI prediction market analyst and trading agent accessible via text message. You're powered by Claude (Anthropic) and connected to Kalshi, the CFTC-regulated prediction market exchange.

You live and breathe prediction markets. You monitor whats happening in the world, understand how events translate to market movements, and help users research, analyze, and trade on Kalshi — all through text.

Built on the Linq messaging platform (linqapp.com), which bridges iMessage and RCS to your backend.

## What You Do
- Search and browse Kalshi prediction markets
- Analyze market pricing, volume, and liquidity
- Place and manage trades (buy, sell, cancel orders)
- Track portfolio positions, P&L, and balances
- Provide context on why markets are moving (using web search for breaking news)
- Help users understand prediction market mechanics

## How Kalshi Works (so you can explain naturally)
- Kalshi is a CFTC-regulated prediction market. Markets are YES/NO binary contracts.
- Each contract pays out $1 (100c) if correct, $0 if wrong. Buying YES at 65c means you think theres a >65% chance.
- Prices are in CENTS (1-99). The yes + no prices roughly sum to 100.
- Market tickers are uppercase (e.g., KXBTC-26FEB28-T105499.99).
- Markets cover politics, economics, weather, crypto, sports, tech, and more.

## Price Understanding
When users mention prices, convert naturally:
- "65 cents" or "65c" or ".65" or "$0.65" → 65
- "at market" or "whatever the ask is" → use current yes_ask or no_ask
- If they say a percentage like "65%" → thats roughly 65c on the yes side

## Trading Rules
1. ALWAYS confirm order details before placing: ticker, side (yes/no), buy or sell, number of contracts, and price. If ANYTHING is ambiguous, ask.
2. If someone says "buy" without specifying yes/no, ask which side.
3. If someone says "sell" make sure they hold that position — check portfolio if unsure.
4. After placing an order, report the order_id and status (resting vs executed).
5. If an order is resting (not filled), let them know — they might want to adjust or cancel.

## Response Style
Youre texting — write like youre texting a sharp friend who happens to trade markets. NOT an essay. NOT a financial advisor disclaimer fest.

CRITICAL: Mirror how humans actually text:
- Use "---" to split your response into separate messages sent individually
- Each message should be 1-2 sentences max
- ALWAYS split longer responses into 2-4 separate messages with ---
- This is NOT optional — multi-sentence responses MUST be split

Example — instead of one block:
"The fed funds market is pricing in a 72% chance of a cut. Volume is heavy today with 15k contracts traded. The orderbook is thick on the yes side."

Do this:
"fed funds cut is at 72c yes rn
---
volumes been heavy today — 15k contracts
---
books thick on the yes side, good liquidity"

More examples of splitting:

User: "what can you do?"
"im kai — your prediction market trading assistant
---
i can search and analyze kalshi markets, place trades, track your portfolio, and break down why markets are moving
---
just ask me about any topic — politics, crypto, sports, economics — and ill pull up the markets
---
try 'whats trending' or 'search bitcoin' to get started"

User: "how does kalshi work?"
"kalshi is a regulated prediction market — you trade yes/no contracts on real events
---
each contract pays $1 if youre right, $0 if wrong. so buying YES at 65c means you think theres a >65% chance
---
prices are in cents (1-99). the yes + no prices roughly add up to 100
---
you can trade politics, econ, crypto, sports, weather — pretty much anything"

Guidelines:
- NO markdown (no bullets, headers, bold, numbered lists)
- Lowercase by default
- Skip apostrophes — "dont", "cant", "im", "thats"
- Be concise with market data — "yes 65c bid / 67c ask" not "The current bid price is..."
- For portfolio: "$420.69 cash, 3 open positions" — natural, not a report
- When showing search results, lead with the most relevant/highest volume markets
- Mention volume/liquidity when helpful ("this one trades heavy" or "thin book, careful")

The vibe: youre the friend who always knows whats happening in the world, loves prediction markets, and can execute trades in seconds. Knowledgeable but not preachy. Direct but not robotic.

## Sharing Links
When discussing a specific market, include the kalshi.com URL (from the "url" field in tool results) as a SEPARATE message (after ---). iMessage renders these as rich link previews with the market chart and probability — it looks amazing. Dont embed the URL in text, send it alone so iMessage renders the card.

Example:
"govt shutdown sitting at 92c yes rn
---
https://kalshi.com/markets/kxshutdown"

## Commands
- /clear — reset conversation history
- /forget me — erase everything Kai knows about you
- /help — show available commands
- /portfolio — quick portfolio check
- /markets — trending/active markets

## Web Search
Use web search proactively when discussing markets — users want to know WHY a market is moving, not just the price. If someone asks about a political market, search for the latest news. Connect real-world events to market prices.

## Reactions
React to messages sparingly — text responses are always preferred. Use reactions only as supplements.

Standard: love, like, dislike, laugh, emphasize, question
Custom: any emoji (📈 for gains, 📉 for losses, 🔥 for hot markets, etc.)

RULES:
1. Default to text — reactions are supplementary
2. Never react without also sending text unless its truly just an acknowledgment
3. Never write "[reacted with ...]" in your text

## Message Effects
Only use when explicitly requested or for truly special moments (like a big trade filling).

Effects: confetti, fireworks, lasers, balloons, sparkles, celebration
Bubble: slam, loud, gentle, invisible_ink

DEFAULT: Just text. Only add effects if asked or if someone just hit a massive trade.`;

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  // Add user profile info if available
  if (chatContext?.senderHandle) {
    const profile = chatContext.senderProfile;
    if (profile?.name || (profile?.facts && profile.facts.length > 0)) {
      prompt += `\n\n## About the person you're talking to (YOU ALREADY KNOW THIS - don't re-save it!)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (profile.name) {
        prompt += `\nName: ${profile.name} (already saved - do NOT call remember_user for this)`;
      }
      if (profile.facts && profile.facts.length > 0) {
        prompt += `\nThings you remember about them (already saved):\n- ${profile.facts.join('\n- ')}`;
      }
      prompt += `\n\nUse their name naturally in conversation! Only use remember_user for genuinely NEW info.`;
    } else {
      prompt += `\n\n## About the person you're talking to
Handle: ${chatContext.senderHandle}
You don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\n## Group Chat Context
You're in a group chat called ${chatName} with these participants: ${participants}

In group chats:
- Address people by name when responding to them specifically
- Be aware others can see your responses
- Keep responses even shorter since group chats move fast
- Don't react as often in groups - it can feel spammy`;
  }

  if (chatContext?.incomingEffect) {
    prompt += `\n\n## Incoming Message Effect
The user sent their message with a ${chatContext.incomingEffect.type} effect: "${chatContext.incomingEffect.name}". You can acknowledge this if relevant (e.g., "nice ${chatContext.incomingEffect.name} effect!").`;
  }

  if (chatContext?.service) {
    prompt += `\n\n## Messaging Platform
This conversation is happening over ${chatContext.service}.`;
    if (chatContext.service === 'iMessage') {
      prompt += ` All features are available (reactions, effects, typing indicators, read receipts).`;
    } else if (chatContext.service === 'RCS') {
      prompt += ` Reactions and typing indicators work, but screen/bubble effects are not available on RCS.`;
    } else if (chatContext.service === 'SMS') {
      prompt += ` This is basic SMS - no reactions, effects, or typing indicators. Keep responses simple and concise.`;
    }
  }

  if (chatContext?.justOnboarded) {
    prompt += `\n\n## IMPORTANT CONTEXT
This user JUST connected their Kalshi account moments ago. This is their first message after completing onboarding. They set up their API key through the web page you sent them. Welcome them, acknowledge they're all set up, and offer to help them get started — show them what you can do (search markets, check trending, place trades, etc). Keep it hype and concise.`;
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction to the user\'s message. Use standard tapbacks (love, like, laugh, etc.) OR any custom emoji. Custom emoji reactions are great for more expressive responses!',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
        description: 'The reaction type. Use "custom" to send any emoji.',
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom". The emoji to react with (e.g., "🔥", "💯", "🎉", "👀", "🙌").',
      },
    },
    required: ['type'],
  },
};

const EFFECT_TOOL: Anthropic.Tool = {
  name: 'send_effect',
  description: 'Add an iMessage effect to your text response. ONLY use when the user explicitly asks for an effect (e.g. "send lasers", "show me fireworks"). You MUST also write a text message - the effect enhances your text, it does not replace it. Do NOT use for normal conversation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
        description: 'Whether this is a full-screen effect or a bubble effect',
      },
      effect: {
        type: 'string',
        enum: ['confetti', 'fireworks', 'lasers', 'sparkles', 'celebration', 'hearts', 'love', 'balloons', 'happy_birthday', 'echo', 'spotlight', 'slam', 'loud', 'gentle', 'invisible_ink'],
        description: 'The specific effect to use',
      },
    },
    required: ['effect_type', 'effect'],
  },
};

const RENAME_CHAT_TOOL: Anthropic.Tool = {
  name: 'rename_group_chat',
  description: 'Rename the current group chat. ONLY use when someone EXPLICITLY asks to rename/name the chat (e.g., "name this chat", "rename the group"). Do NOT use unprompted or just because conversation is interesting. You MUST also send a text response when renaming.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'The new name for the group chat',
      },
    },
    required: ['name'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save NEW information about someone. ONLY use when you learn genuinely NEW info. NEVER re-save info already shown in the system prompt. CRITICAL: You MUST write a text response too - this tool does NOT send any message, so if you use it without text, the user gets nothing!',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: 'The phone number/handle of the person this info is about. In group chats, use this to save info about someone OTHER than the current sender. If omitted, saves to the current sender.',
      },
      name: {
        type: 'string',
        description: 'The person\'s name if they shared it (e.g., "Patrick", "Sarah"). Set this whenever you learn someone\'s name!',
      },
      fact: {
        type: 'string',
        description: 'An interesting fact about them worth remembering (e.g., "Works at Google", "Has a dog named Max", "Loves hiking"). Keep facts concise.',
      },
    },
  },
};

// Web search uses a special tool type - cast to bypass strict typing
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

// ─── Kalshi Tools ────────────────────────────────────────────────────────────

const KALSHI_TRENDING_TOOL: Anthropic.Tool = {
  name: 'kalshi_trending',
  description: 'Get the hottest markets on Kalshi right now, sorted by 24-hour trading volume. Use when someone asks whats hot, trending, popular, active, or wants to browse markets without a specific keyword.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

const KALSHI_SEARCH_TOOL: Anthropic.Tool = {
  name: 'kalshi_search',
  description: 'Search Kalshi prediction markets by keyword. Returns matching markets with tickers, prices, volume, and status. Use when someone asks about markets or wants to find a specific event.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword (e.g., "fed rate", "trump", "bitcoin", "super bowl").',
      },
    },
    required: ['query'],
  },
};

const KALSHI_MARKET_TOOL: Anthropic.Tool = {
  name: 'kalshi_market',
  description: 'Get detailed info for a specific Kalshi market by ticker. Returns current yes/no bid/ask prices, volume, open interest, and status.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ticker: {
        type: 'string',
        description: 'The market ticker (uppercase, e.g., "KXFEDCHAIRNOM-29-JS").',
      },
    },
    required: ['ticker'],
  },
};

const KALSHI_ORDERBOOK_TOOL: Anthropic.Tool = {
  name: 'kalshi_orderbook',
  description: 'Get the order book for a Kalshi market — shows bid price levels and quantities for both yes and no sides. Use to check liquidity/depth before trading.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ticker: {
        type: 'string',
        description: 'The market ticker (uppercase).',
      },
      depth: {
        type: 'number',
        description: 'Number of price levels to return (default 10).',
      },
    },
    required: ['ticker'],
  },
};

const KALSHI_BUY_TOOL: Anthropic.Tool = {
  name: 'kalshi_buy',
  description: 'Place a limit BUY order on Kalshi. CRITICAL: Confirm order details with the user before calling. Prices are in CENTS (1-99).',
  input_schema: {
    type: 'object' as const,
    properties: {
      ticker: {
        type: 'string',
        description: 'The market ticker (uppercase).',
      },
      side: {
        type: 'string',
        enum: ['yes', 'no'],
        description: 'Which side to buy: "yes" or "no".',
      },
      count: {
        type: 'number',
        description: 'Number of contracts to buy.',
      },
      price: {
        type: 'number',
        description: 'Limit price in cents (1-99). 65 means $0.65 per contract.',
      },
    },
    required: ['ticker', 'side', 'count', 'price'],
  },
};

const KALSHI_SELL_TOOL: Anthropic.Tool = {
  name: 'kalshi_sell',
  description: 'Place a limit SELL order on Kalshi to exit a position. CRITICAL: Confirm order details with the user before calling. The user must hold the position they are selling.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ticker: {
        type: 'string',
        description: 'The market ticker (uppercase).',
      },
      side: {
        type: 'string',
        enum: ['yes', 'no'],
        description: 'Which side to sell: "yes" or "no".',
      },
      count: {
        type: 'number',
        description: 'Number of contracts to sell.',
      },
      price: {
        type: 'number',
        description: 'Limit price in cents (1-99).',
      },
    },
    required: ['ticker', 'side', 'count', 'price'],
  },
};

const KALSHI_CANCEL_TOOL: Anthropic.Tool = {
  name: 'kalshi_cancel',
  description: 'Cancel a resting (unfilled) order on Kalshi by its order_id. Get the order_id from kalshi_orders or from the order confirmation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      order_id: {
        type: 'string',
        description: 'The order ID to cancel.',
      },
    },
    required: ['order_id'],
  },
};

const KALSHI_ORDERS_TOOL: Anthropic.Tool = {
  name: 'kalshi_orders',
  description: 'View Kalshi orders. Can filter by status (resting, executed, canceled) and/or ticker. Use to check if orders filled, see resting orders, or review recent activity.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['resting', 'executed', 'canceled'],
        description: 'Filter by order status. Omit to see all.',
      },
      ticker: {
        type: 'string',
        description: 'Filter by market ticker.',
      },
    },
  },
};

const KALSHI_FILLS_TOOL: Anthropic.Tool = {
  name: 'kalshi_fills',
  description: 'View recent Kalshi trade fills — actual executions. Shows what price and quantity each trade filled at.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ticker: {
        type: 'string',
        description: 'Filter fills by market ticker.',
      },
    },
  },
};

const KALSHI_PORTFOLIO_TOOL: Anthropic.Tool = {
  name: 'kalshi_portfolio',
  description: 'Check the Kalshi portfolio — account balance (in dollars), portfolio value, and all current positions. Use when someone asks about balance, positions, P&L, or portfolio.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

// Tools that return data Claude needs to reason about (require tool-use loop)
const DATA_RETRIEVAL_TOOLS = new Set([
  'kalshi_trending', 'kalshi_search', 'kalshi_market', 'kalshi_orderbook',
  'kalshi_buy', 'kalshi_sell', 'kalshi_cancel',
  'kalshi_orders', 'kalshi_fills', 'kalshi_portfolio',
]);

// Action tools that mutate state — don't send intermediate text before these
const ACTION_TOOLS = new Set([
  'kalshi_buy', 'kalshi_sell', 'kalshi_cancel',
]);

const MAX_TOOL_LOOPS = 5;

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  renameChat: string | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
}

export interface ImageInput {
  url: string;
  mimeType: string;
}

export interface AudioInput {
  url: string;
  mimeType: string;
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  incomingEffect?: { type: 'screen' | 'bubble'; name: string };
  senderHandle?: string;
  senderProfile?: UserProfile | null;
  service?: MessageService;
  kalshiCredentials?: KalshiCredentials | null;
  justOnboarded?: boolean;
}

/**
 * Convert stored messages to Anthropic format, adding sender attribution for group chats.
 * In group chats, user messages are prefixed with the sender's handle so Claude knows who said what.
 */
function formatHistoryForClaude(messages: StoredMessage[], isGroupChat: boolean): Anthropic.MessageParam[] {
  return messages.map(msg => {
    let content = msg.content;

    // In group chats, prefix user messages with who sent them
    if (isGroupChat && msg.role === 'user' && msg.handle) {
      content = `[${msg.handle}]: ${content}`;
    }

    return {
      role: msg.role,
      content: content,
    };
  });
}

export async function chat(chatId: string, userMessage: string, images: ImageInput[] = [], audio: AudioInput[] = [], chatContext?: ChatContext): Promise<ChatResponse> {
  const emptyResponse = {
    reaction: null,
    effect: null,
    renameChat: null,
    rememberedUser: null,
  };

  const cmd = userMessage.toLowerCase().trim();

  // Handle special commands
  if (cmd === '/help') {
    return {
      text: "commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/help - this message",
      ...emptyResponse,
    };
  }

  if (cmd === '/clear') {
    await clearConversation(chatId);
    return {
      text: "conversation cleared, fresh start 🧹",
      ...emptyResponse,
    };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (chatContext?.senderHandle) {
      await clearUserProfile(chatContext.senderHandle);
      return {
        text: "done, i've forgotten everything about you. we're strangers now 👋",
        ...emptyResponse,
      };
    }
    return {
      text: "hmm couldn't figure out who you are to forget you",
      ...emptyResponse,
    };
  }

  // Per-user Kalshi client (from credentials passed via chatContext)
  const kalshi = chatContext?.kalshiCredentials
    ? createUserKalshiClient(chatContext.kalshiCredentials)
    : null;

  // For public data (trending, search, market info, orderbook) use user client or fallback
  const publicKalshi = kalshi ?? defaultKalshi;

  // Get conversation history (keyed by chat_id to keep conversations separate)
  const history = await getConversation(chatId);

  // Build message content (text + images + audio)
  const messageContent: Anthropic.ContentBlockParam[] = [];

  // Add images first
  for (const image of images) {
    messageContent.push({
      type: 'image',
      source: {
        type: 'url',
        url: image.url,
      },
    });
    console.log(`[claude] Including image: ${image.url.substring(0, 50)}...`);
  }

  // Build the text to send
  let textToSend = userMessage.trim();

  if (!textToSend) {
    // Default prompts for images only
    if (images.length > 0) {
      textToSend = "What's in this image?";
    }
  }
  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
  }

  // Add user message to history with sender handle (for group chat attribution)
  if (textToSend) {
    await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);
  }

  try {
    if (chatContext?.isGroupChat) {
      console.log(`[claude] Group chat detected: ${chatContext.participantNames.length} participants`);
    }

    // Format history with sender attribution for group chats
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);

    // Build tools list — public tools always available, trading tools only with credentials
    const tools: Anthropic.Tool[] = [
      REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL,
    ];
    // Public market data tools — available if any kalshi client exists
    if (publicKalshi) {
      tools.push(KALSHI_TRENDING_TOOL, KALSHI_SEARCH_TOOL, KALSHI_MARKET_TOOL, KALSHI_ORDERBOOK_TOOL);
    }
    // Authenticated trading tools — only with per-user credentials
    if (kalshi) {
      tools.push(KALSHI_BUY_TOOL, KALSHI_SELL_TOOL, KALSHI_CANCEL_TOOL,
        KALSHI_ORDERS_TOOL, KALSHI_FILLS_TOOL, KALSHI_PORTFOLIO_TOOL);
    }
    if (chatContext?.isGroupChat) {
      tools.push(RENAME_CHAT_TOOL);
    }

    // ── Tool-use loop ──────────────────────────────────────────────────────
    // Data-retrieval tools (Kalshi queries) get results looped back to Claude.
    // Fire-and-forget tools (reactions, effects, remember) are extracted at the end.
    const messages: Anthropic.MessageParam[] = [...formattedHistory, { role: 'user', content: messageContent }];
    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(chatContext),
      tools,
      messages,
    });

    let loopCount = 0;
    while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
      const hasDataTools = response.content.some(
        block => block.type === 'tool_use' && DATA_RETRIEVAL_TOOLS.has(block.name)
      );
      if (!hasDataTools) break; // Only fire-and-forget tools — no need to loop

      console.log(`[claude] Tool-use loop iteration ${loopCount + 1}`);

      // Build tool_result blocks for all tool_use blocks in this response
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // ── Kalshi tool execution ──────────────────────────────────────
        if (block.name === 'kalshi_trending') {
          try {
            const markets = await publicKalshi!.getTrendingMarkets(15);
            const slim = markets.map(m => ({
              ticker: m.ticker,
              event_ticker: m.event_ticker,
              title: m.title,
              subtitle: m.subtitle,
              yes_bid: m.yes_bid_dollars,
              yes_ask: m.yes_ask_dollars,
              volume_24h: m.volume_24h_fp,
              volume_total: m.volume_fp,
              status: m.status,
              url: `https://kalshi.com/markets/${m.series_ticker.toLowerCase()}`,
            }));
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slim) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_trending error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching trending markets: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_search') {
          const input = block.input as { query: string };
          try {
            const markets = await publicKalshi!.searchMarkets(input.query);
            const slim = markets.map(m => ({
              ticker: m.ticker,
              title: m.title,
              subtitle: m.subtitle,
              yes_bid: m.yes_bid_dollars,
              yes_ask: m.yes_ask_dollars,
              no_bid: m.no_bid_dollars,
              no_ask: m.no_ask_dollars,
              volume: m.volume_fp,
              status: m.status,
              url: kalshiUrl(m.event_ticker),
            }));
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slim) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_search error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error searching Kalshi: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_market') {
          const input = block.input as { ticker: string };
          try {
            const { market } = await publicKalshi!.getMarket(input.ticker);
            const slim = {
              ticker: market.ticker,
              title: market.title,
              subtitle: market.subtitle,
              yes_bid: market.yes_bid_dollars,
              yes_ask: market.yes_ask_dollars,
              no_bid: market.no_bid_dollars,
              no_ask: market.no_ask_dollars,
              volume: market.volume_fp,
              open_interest: market.open_interest_fp,
              status: market.status,
              close_time: market.close_time,
              url: kalshiUrl(market.event_ticker),
            };
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slim) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_market error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching market: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_orderbook') {
          const input = block.input as { ticker: string; depth?: number };
          try {
            const book = await publicKalshi!.getOrderbook(input.ticker, input.depth);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(book) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_orderbook error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching orderbook: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_buy') {
          const input = block.input as { ticker: string; side: 'yes' | 'no'; count: number; price: number };
          try {
            const yesPrice = input.side === 'no' ? 100 - input.price : input.price;
            const result = await kalshi!.createOrder({
              ticker: input.ticker,
              side: input.side,
              action: 'buy',
              count: input.count,
              yes_price: yesPrice,
            });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({
              order_id: result.order.order_id,
              status: result.order.status,
              ticker: result.order.ticker,
              side: result.order.side,
              yes_price: result.order.yes_price,
              filled: result.order.fill_count,
              remaining: result.order.remaining_count,
            }) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_buy error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error placing buy order: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_sell') {
          const input = block.input as { ticker: string; side: 'yes' | 'no'; count: number; price: number };
          try {
            const yesPrice = input.side === 'no' ? 100 - input.price : input.price;
            const result = await kalshi!.createOrder({
              ticker: input.ticker,
              side: input.side,
              action: 'sell',
              count: input.count,
              yes_price: yesPrice,
            });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({
              order_id: result.order.order_id,
              status: result.order.status,
              ticker: result.order.ticker,
              side: result.order.side,
              yes_price: result.order.yes_price,
              filled: result.order.fill_count,
              remaining: result.order.remaining_count,
            }) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_sell error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error placing sell order: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_cancel') {
          const input = block.input as { order_id: string };
          try {
            const result = await kalshi!.cancelOrder(input.order_id);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({
              order_id: result.order.order_id,
              status: result.order.status,
            }) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_cancel error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error cancelling order: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_orders') {
          const input = block.input as { status?: 'resting' | 'executed' | 'canceled'; ticker?: string };
          try {
            const result = await kalshi!.getOrders({ status: input.status, ticker: input.ticker, limit: 20 });
            const slim = result.orders.map(o => ({
              order_id: o.order_id,
              ticker: o.ticker,
              side: o.side,
              action: o.action,
              status: o.status,
              yes_price: o.yes_price,
              count: o.initial_count,
              filled: o.fill_count,
              remaining: o.remaining_count,
              created: o.created_time,
            }));
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slim) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_orders error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching orders: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_fills') {
          const input = block.input as { ticker?: string };
          try {
            const result = await kalshi!.getFills({ ticker: input.ticker, limit: 20 });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result.fills) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_fills error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching fills: ${msg}`, is_error: true });
          }

        } else if (block.name === 'kalshi_portfolio') {
          try {
            const portfolio = await kalshi!.getPortfolio();
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(portfolio) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] kalshi_portfolio error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching portfolio: ${msg}`, is_error: true });
          }

        } else {
          // Fire-and-forget tools — send back a simple ack so the API is happy
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
        }
      }

      // Append assistant response + tool results, then call Claude again
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(chatContext),
        tools,
        messages,
      });

      loopCount++;
    }

    // ── Extract fire-and-forget tools from ALL responses ─────────────────
    let reaction: Reaction | null = null;
    let effect: MessageEffect | null = null;
    let renameChat: string | null = null;
    let rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null = null;

    // Collect blocks from intermediate loop responses + final response
    const allAssistantBlocks = messages
      .filter((m): m is Anthropic.MessageParam & { role: 'assistant' } => m.role === 'assistant')
      .flatMap(m => Array.isArray(m.content) ? m.content : []);
    const allBlocks = [...allAssistantBlocks, ...response.content];

    for (const block of allBlocks) {
      if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: ReactionType; emoji?: string };
        if (input.type === 'custom' && input.emoji) {
          reaction = { type: 'custom', emoji: input.emoji };
          console.log(`[claude] Wants to react with custom emoji: ${input.emoji}`);
        } else if (input.type !== 'custom') {
          reaction = { type: input.type as StandardReactionType };
          console.log(`[claude] Wants to react with: ${input.type}`);
        }
      } else if (block.type === 'tool_use' && block.name === 'send_effect') {
        const input = block.input as { effect_type: 'screen' | 'bubble'; effect: string };
        effect = { type: input.effect_type, name: input.effect };
        console.log(`[claude] Wants to send with effect: ${input.effect_type} - ${input.effect}`);
      } else if (block.type === 'tool_use' && block.name === 'rename_group_chat') {
        const input = block.input as { name: string };
        renameChat = input.name;
        console.log(`[claude] Wants to rename chat to: ${renameChat}`);
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { handle?: string; name?: string; fact?: string };
        const targetHandle = input.handle || chatContext?.senderHandle;
        if (targetHandle) {
          let nameChanged = false;
          let factChanged = false;

          if (input.name) {
            nameChanged = await setUserName(targetHandle, input.name);
            if (nameChanged) {
              console.log(`[claude] Remembered name for ${targetHandle}: ${input.name}`);
            } else {
              console.log(`[claude] Name already known for ${targetHandle}, skipped`);
            }
          }
          if (input.fact) {
            factChanged = await addUserFact(targetHandle, input.fact);
            if (factChanged) {
              console.log(`[claude] Remembered fact for ${targetHandle}: ${input.fact}`);
            } else {
              console.log(`[claude] Fact already known for ${targetHandle}, skipped`);
            }
          }

          if (nameChanged || factChanged) {
            const isForSender = !input.handle || input.handle === chatContext?.senderHandle;
            rememberedUser = {
              name: nameChanged ? input.name : undefined,
              fact: factChanged ? input.fact : undefined,
              isForSender
            };
          }
        }
      }
    }

    // Only take text from the FINAL response (intermediate text is tool-use chatter)
    const finalTextParts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        finalTextParts.push(block.text);
      }
    }
    const textResponse = finalTextParts.length > 0 ? finalTextParts.join('\n') : null;

    // Add assistant response to history
    if (textResponse) {
      const historyMessage = textResponse.split('---').map(m => m.trim()).filter(m => m).join(' ');
      await addMessage(chatId, 'assistant', historyMessage);
    } else if (effect) {
      await addMessage(chatId, 'assistant', `[sent ${effect.name} effect]`);
    } else if (reaction) {
      const reactionDisplay = reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
      await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
    }

    return { text: textResponse, reaction, effect, renameChat, rememberedUser };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}

/**
 * Simple text-only completion for follow-up requests (no tools).
 */
export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a very short, fun message (under 10 words) to send with a ${effectName} iMessage effect. Just the message, nothing else.`
    }],
  });

  if (response.content[0].type === 'text') {
    return response.content[0].text;
  }
  return `✨ ${effectName}! ✨`;
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

/**
 * Use Haiku to quickly determine how Claude should handle a group chat message.
 * Returns 'respond' (full message), 'react' (just tapback), or 'ignore'.
 */
export async function getGroupChatAction(
  message: string,
  sender: string,
  chatId: string
): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const start = Date.now();

  // Get recent conversation history for context (keyed by chat_id)
  const history = await getConversation(chatId);
  const recentMessages = history.slice(-4); // Last 2 exchanges

  let contextBlock = '';
  if (recentMessages.length > 0) {
    // Format with sender handles so Claude knows who said what
    const formatted = recentMessages.map(msg => {
      if (msg.role === 'assistant') {
        return `Claude: ${msg.content}`;
      } else {
        // Show who sent the message in group chats
        const sender = msg.handle || 'Someone';
        return `${sender}: ${msg.content}`;
      }
    }).join('\n');
    contextBlock = `\nRecent conversation:\n${formatted}\n`;
    console.log(`[claude] groupChatAction context (${recentMessages.length} msgs): ${formatted.substring(0, 100)}...`);
  } else {
    console.log(`[claude] groupChatAction context: no recent messages`);
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      system: `You classify how an AI trading assistant "Kai" should handle messages in a group chat.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions. Only use "react" for very brief acknowledgments where a text response would be awkward.

Answer with ONE of these:
- "respond" - Kai should send a text reply. USE THIS BY DEFAULT when:
  * They asked Kai anything
  * They mentioned Kai, "the bot", "AI", or "trading bot"
  * They're talking about markets, trades, predictions, or Kalshi
  * They're continuing a conversation with Kai
  * It's a follow-up to Kai's message
  * You're unsure - default to respond
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments where text would be weird (like a simple "thanks!" or "lol"). Do NOT overuse reactions.
- "ignore" - Human-to-human conversation not involving Kai at all

Examples:
- "kai whats the market on the fed" -> respond
- "hey kai thoughts?" -> respond
- "what are the odds on that" -> respond (market question)
- "thanks!" (very brief, nothing to add) -> react:love
- "yo mike you coming tonight?" -> ignore`,
      messages: [{
        role: 'user',
        content: `${contextBlock}New message from ${sender}: "${message}"\n\nHow should Kai handle this?`
      }],
    });

    const answer = response.content[0].type === 'text'
      ? response.content[0].text.toLowerCase().trim()
      : 'ignore';

    let action: GroupChatAction = 'ignore';
    let reaction: Reaction | undefined;

    if (answer.includes('respond')) {
      action = 'respond';
    } else if (answer.includes('react')) {
      action = 'react';
      if (answer.includes('love')) reaction = { type: 'love' };
      else if (answer.includes('laugh')) reaction = { type: 'laugh' };
      else if (answer.includes('like')) reaction = { type: 'like' };
      else if (answer.includes('emphasize')) reaction = { type: 'emphasize' };
      else reaction = { type: 'like' }; // default reaction
    }

    const reactionDisplay = reaction ? (reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type) : '';
    console.log(`[claude] groupChatAction (${Date.now() - start}ms): "${message.substring(0, 50)}..." -> ${action}${reactionDisplay ? `:${reactionDisplay}` : ''}`);

    return { action, reaction };
  } catch (error) {
    console.error('[claude] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
