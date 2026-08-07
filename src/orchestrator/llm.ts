import axios from 'axios';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';

// ─── Groq client ───────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: env.GROQ_API_KEY });

// ─── Gemini fallback client ─────────────────────────────────────────────────────
let gemini: GoogleGenerativeAI | null = null;
if (env.GEMINI_API_KEY) {
  gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);
}

// ─── Types ──────────────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export interface LLMResponse {
  content: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  provider: string;
}

// ─── Model Cooldown / Circuit Breaker ──────────────────────────────────────────
const modelCooldowns: Record<string, number> = {};

// How long to skip a model after a rate-limit (429). Kept short so a single 429 on
// Groq's free tier doesn't route every message to slower fallbacks for minutes.
const RATE_LIMIT_COOLDOWN_MS = 60000;

function isModelCoolingDown(modelName: string): boolean {
  const until = modelCooldowns[modelName];
  if (!until) return false;
  if (Date.now() > until) {
    delete modelCooldowns[modelName];
    return false;
  }
  return true;
}

function markModelCoolingDown(modelName: string, durationMs = RATE_LIMIT_COOLDOWN_MS): void {
  modelCooldowns[modelName] = Date.now() + durationMs;
}

// ─── Code Leak Sanitization & Fallback Tool Call Extraction ───────────────────
export function sanitizeLLMOutput(text: string): string {
  if (!text) return '';
  return text
    // Remove function=tool_name>{"arg":"val"} or function=toolname>{"arg":"val"} or function=tool_name> arg=val
    .replace(/function\s*=\s*[a-zA-Z0-9_]+\s*>?:?\s*(\{[^}]*\}|[^\n]*)/gi, '')
    // Remove tool_name>{"arg":"val"} pattern
    .replace(/(?:[a-zA-Z0-9_]+>)?\{"[a-zA-Z0-9_]+"\s*:[\s\S]*?\}/gi, (match) => {
      if (
        match.includes('ticker') ||
        match.includes('role') ||
        match.includes('action') ||
        match.includes('watchlist') ||
        match.includes('holdings')
      ) {
        return '';
      }
      return match;
    })
    // Remove XML/HTML-style tool tags like <function=...>...</function>, <tool_call>...</tool_call>
    .replace(/<[a-zA-Z_0-9\-=\/]+[^>]*>[\s\S]*?<\/[a-zA-Z_0-9\-]+>/gi, '')
    .replace(/<[a-zA-Z_0-9\-=\/]+[^>]*>/gi, '')
    // Remove JSON profile/state leaks
    .replace(/\{"(role|sectors|watchlist|portfolio|onboarding)"[\s\S]*?\}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractFallbackToolCalls(content: string): { name: string; args: Record<string, unknown> }[] {
  if (!content) return [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

  const toolNameMap: Record<string, string> = {
    getcompanyprofile: 'get_company_profile',
    getstockquote: 'get_stock_quote',
    getmarketnews: 'get_market_news',
    getearningscalendar: 'get_earnings_calendar',
    getearningshistory: 'get_earnings_history',
    getcompanynews: 'get_company_news',
    getanalystratings: 'get_analyst_ratings',
    getsecfilings: 'get_sec_filings',
    searchsecfilings: 'search_sec_filings',
    getpricehistory: 'get_price_history',
  };

  const validToolNames = [
    'get_stock_quote',
    'get_company_profile',
    'get_earnings_calendar',
    'get_earnings_history',
    'get_company_news',
    'get_market_news',
    'get_analyst_ratings',
    'get_sec_filings',
    'search_sec_filings',
    'get_price_history',
    'update_user_watchlist',
    'update_user_portfolio',
    'set_briefing_preference',
    'update_user_profile',
  ];

  const regex = /(?:function=|<function=)?([a-zA-Z0-9_]+)>?\s*(\{[\s\S]*?\})/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const rawName = match[1].toLowerCase();
    const mappedName = toolNameMap[rawName] || match[1];

    if (validToolNames.includes(mappedName)) {
      try {
        const args = JSON.parse(match[2]) as Record<string, unknown>;
        toolCalls.push({ name: mappedName, args });
      } catch {
        // Ignore invalid JSON args
      }
    }
  }

  return toolCalls;
}

// ─── Primary: Groq ──────────────────────────────────────────────────────────────
async function callGroq(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  model = 'llama-3.3-70b-versatile',
  maxTokens = 450,
  forceTool = false
): Promise<LLMResponse> {
  if (isModelCoolingDown(model)) {
    throw new Error(`Model ${model} is temporarily cooling down after a rate limit.`);
  }

  const groqMessages = messages.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  const params: Parameters<typeof groq.chat.completions.create>[0] = {
    model,
    messages: groqMessages,
    temperature: 0.7,
    max_tokens: maxTokens,
  };

  if (tools && tools.length > 0) {
    params.tools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    params.tool_choice = forceTool ? 'required' : 'auto';
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await groq.chat.completions.create({ ...params, stream: false } as any) as any;
    const choice = response.choices[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let toolCalls = choice.message.tool_calls?.map((tc: any) => ({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
    }));

    let rawContent = choice.message.content || '';
    if (!toolCalls || toolCalls.length === 0) {
      const fallback = extractFallbackToolCalls(rawContent);
      if (fallback.length > 0) {
        toolCalls = fallback;
      }
    }

    const content = sanitizeLLMOutput(rawContent);

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      provider: `groq (${model})`,
    };

  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate limit')) {
      markModelCoolingDown(model, RATE_LIMIT_COOLDOWN_MS); // short cooldown for rate-limited Groq models
    }
    throw err;
  }
}

// ─── Fallback: Gemini ───────────────────────────────────────────────────────────
async function callGemini(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  modelName = 'gemini-2.5-flash',
  maxTokens = 450
): Promise<LLMResponse> {
  if (!gemini) throw new Error('Gemini API key not configured');
  if (isModelCoolingDown(modelName)) {
    throw new Error(`Model ${modelName} is temporarily cooling down after a rate limit.`);
  }

  // Convert tools to Gemini format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const functionDeclarations = tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as any,
  }));

  const model = gemini.getGenerativeModel({
    model: modelName,
    generationConfig: { maxOutputTokens: maxTokens },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: functionDeclarations && functionDeclarations.length > 0 ? [{ functionDeclarations: functionDeclarations as any }] : undefined,
  });

  // Convert to Gemini format — system prompt becomes the first user turn context
  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');

  const history = chatMessages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMessage = chatMessages[chatMessages.length - 1];
  const userPrompt = systemMsg
    ? `Context: ${systemMsg.content}\n\n${lastMessage?.content || ''}`
    : lastMessage?.content || '';

  try {
    const chatSession = model.startChat({ history });
    const result = await chatSession.sendMessage(userPrompt);

    const functionCalls = result.response.functionCalls();
    let toolCalls = functionCalls?.map((fc) => ({
      name: fc.name,
      args: (fc.args || {}) as Record<string, unknown>,
    }));

    let rawText = '';
    try {
      rawText = result.response.text();
    } catch {
      rawText = '';
    }

    if (!toolCalls || toolCalls.length === 0) {
      const fallback = extractFallbackToolCalls(rawText);
      if (fallback.length > 0) {
        toolCalls = fallback;
      }
    }

    const content = sanitizeLLMOutput(rawText);

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      provider: `gemini (${modelName})`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
      markModelCoolingDown(modelName, RATE_LIMIT_COOLDOWN_MS);
    }
    throw err;
  }
}

// ─── Agent Router / OpenRouter Provider ─────────────────────────────────────────
async function callAgentRouter(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  modelName = 'anthropic/claude-3.5-sonnet',
  maxTokens = 450,
  forceTool = false
): Promise<LLMResponse> {
  if (!env.AGENT_ROUTER_API_KEY) throw new Error('Agent Router API key not configured');
  if (isModelCoolingDown(modelName)) {
    throw new Error(`Model ${modelName} is temporarily cooling down.`);
  }

  try {
    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: modelName,
      messages: formattedMessages,
      temperature: 0.7,
      max_tokens: maxTokens,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = forceTool ? 'required' : 'auto';
    }

    const { data } = await axios.post(
      `${env.AGENT_ROUTER_BASE_URL}/chat/completions`,
      body,
      {
        headers: {
          Authorization: `Bearer ${env.AGENT_ROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://atlas.ai',
          'X-Title': 'Atlas',
        },
        timeout: 7000,
      }
    );

    const choice = data.choices[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let toolCalls = choice.message?.tool_calls?.map((tc: any) => ({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}'),
    }));

    const rawContent = choice.message?.content || '';
    if (!toolCalls || toolCalls.length === 0) {
      const fallback = extractFallbackToolCalls(rawContent);
      if (fallback.length > 0) {
        toolCalls = fallback;
      }
    }

    const content = sanitizeLLMOutput(rawContent);

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      provider: `agent-router (${modelName})`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('quota')) {
      markModelCoolingDown(modelName, RATE_LIMIT_COOLDOWN_MS);
    }
    throw err;
  }
}

// ─── Groq Streaming Call ──────────────────────────────────────────────────────
async function callGroqStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  onChunk?: (text: string) => void | Promise<void>,
  model = 'llama-3.3-70b-versatile',
  maxTokens = 450,
  forceTool = false
): Promise<LLMResponse> {
  if (isModelCoolingDown(model)) {
    throw new Error(`Model ${model} is cooling down.`);
  }

  const groqMessages = messages.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  const params: Parameters<typeof groq.chat.completions.create>[0] = {
    model,
    messages: groqMessages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true,
  };

  if (tools && tools.length > 0) {
    params.tools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    // forceTool: the user named an asset and wants a live number — the model MUST call a
    // tool (it still picks which), so it can never answer a price from memory. 'auto'
    // otherwise, letting it skip tools for genuine chit-chat.
    params.tool_choice = forceTool ? 'required' : 'auto';
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await groq.chat.completions.create(params as any)) as unknown as AsyncIterable<any>;

    let fullContent = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulatedToolCalls: Record<number, { name: string; argsStr: string }> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        fullContent += delta.content;
        if (onChunk) {
          // Awaited on purpose: the callback may send/replace a Telegram message and
          // assign the streamMessage handle. If we fire-and-forget, a fast synthesis can
          // finish and finalize BEFORE that first reply resolves — finalize then sees a
          // null handle and posts a SECOND message, leaving the partial orphaned. The
          // 800ms throttle makes this a no-op on most chunks, so it costs nothing.
          await onChunk(fullContent);
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          if (!accumulatedToolCalls[index]) {
            accumulatedToolCalls[index] = { name: '', argsStr: '' };
          }
          if (tc.function?.name) {
            accumulatedToolCalls[index].name += tc.function.name;
          }
          if (tc.function?.arguments) {
            accumulatedToolCalls[index].argsStr += tc.function.arguments;
          }
        }
      }
    }

    let toolCalls = Object.values(accumulatedToolCalls)
      .filter((tc) => tc.name.length > 0)
      .map((tc) => ({
        name: tc.name,
        args: JSON.parse(tc.argsStr || '{}') as Record<string, unknown>,
      }));

    if (!toolCalls || toolCalls.length === 0) {
      const fallback = extractFallbackToolCalls(fullContent);
      if (fallback.length > 0) {
        toolCalls = fallback;
      }
    }

    const cleanedContent = sanitizeLLMOutput(fullContent);

    return {
      content: cleanedContent,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      provider: `groq-stream (${model})`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate limit')) {
      markModelCoolingDown(model, RATE_LIMIT_COOLDOWN_MS);
    }
    throw err;
  }
}

// ─── Dynamic Model Router (Fast 8B for chat/quotes vs 70B for deep research) ────
export function selectOptimalModel(userQuery: string): string {
  const q = userQuery.toLowerCase();
  const deepResearchKeywords = [
    'compare', 'comparison', 'versus', ' vs ',
    'analyze', 'analysis', 'deep dive',
    'valuation', 'dcf', 'financial statement',
    'balance sheet', 'income statement', 'cash flow',
    '10-k', '10-q', 'sec filing', 'annual report',
    'audit', 'risk factors', 'forecast',
  ];

  const isDeepQuery = deepResearchKeywords.some((keyword) => q.includes(keyword));
  return isDeepQuery ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';
}

// ─── Public interface with multi-tier resilience fallback ───────────────────
export async function chat(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  preferredModel?: string,
  maxTokens = 450,
  forceTool = false
): Promise<LLMResponse> {
  const targetModel = preferredModel || 'llama-3.1-8b-instant';

  // Tier 1: Groq primary — the routed model (8B for chat, 70B for deep research).
  if (!isModelCoolingDown(targetModel)) {
    try {
      return await callGroq(messages, tools, targetModel, maxTokens, forceTool);
    } catch (groqError1) {
      console.warn(`[LLM] Groq ${targetModel} failed:`, (groqError1 as Error).message);
    }
  }

  // Tier 2: Groq 8B Instant — skip if it's the same model we just tried above.
  if (targetModel !== 'llama-3.1-8b-instant' && !isModelCoolingDown('llama-3.1-8b-instant')) {
    try {
      return await callGroq(messages, tools, 'llama-3.1-8b-instant', maxTokens, forceTool);
    } catch (groqError2) {
      console.warn('[LLM] Groq 8B Instant failed:', (groqError2 as Error).message);
    }
  }

  // Tier 3: Agent Router (if AGENT_ROUTER_API_KEY is provided & valid)
  if (env.AGENT_ROUTER_API_KEY && !isModelCoolingDown('anthropic/claude-3.5-sonnet')) {
    try {
      return await callAgentRouter(messages, tools, 'anthropic/claude-3.5-sonnet', maxTokens, forceTool);
    } catch (agentRouterError) {
      console.warn('[LLM] Agent Router failed:', (agentRouterError as Error).message);
    }
  }

  // Tier 4: Gemini 2.5 Flash (1,500 RPD free tier quota) — final fallback.
  try {
    return await callGemini(messages, tools, 'gemini-2.5-flash', maxTokens);
  } catch (finalError) {
    console.error('[LLM] All provider models failed:', (finalError as Error).message);
    throw new Error('All AI model quotas are currently exhausted. Please try again in a few minutes.');
  }
}

// ─── Public interface for Streaming responses ───────────────────────────────
export async function chatStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  onChunk?: (text: string) => void | Promise<void>,
  preferredModel?: string,
  maxTokens = 450,
  forceTool = false
): Promise<LLMResponse> {
  const started = Date.now();
  try {
    const res = await callGroqStream(messages, tools, onChunk, preferredModel, maxTokens, forceTool);
    console.log(`[LLM/timing] ${res.provider} ${Date.now() - started}ms (tools=${tools ? tools.length : 0}, force=${forceTool})`);
    return res;
  } catch {
    const res = await chat(messages, tools, preferredModel, maxTokens, forceTool);
    console.log(`[LLM/timing] fallback ${res.provider} ${Date.now() - started}ms (tools=${tools ? tools.length : 0}, force=${forceTool})`);
    return res;
  }
}

// ─── Groq Whisper voice transcription ──────────────────────────────────────────
export async function transcribeVoice(audioBuffer: Buffer, fileName: string): Promise<string> {
  const file = new File([new Uint8Array(audioBuffer)], fileName, { type: 'audio/ogg' });

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3-turbo',
    response_format: 'text',
  });

  return typeof transcription === 'string' ? transcription : (transcription as { text: string }).text;
}

// ─── Groq vision (image understanding) ─────────────────────────────────────────
export async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  try {
    // Try Groq vision first (llama-4-scout or equivalent)
    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: 1024,
    });
    return response.choices[0].message.content || '';
  } catch {
    // Fallback to Gemini vision
    if (!gemini) throw new Error('No vision-capable provider available');
    const model = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      prompt,
      { inlineData: { data: imageBase64, mimeType } },
    ]);
    return result.response.text();
  }
}
