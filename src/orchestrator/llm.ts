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

function isModelCoolingDown(modelName: string): boolean {
  const until = modelCooldowns[modelName];
  if (!until) return false;
  if (Date.now() > until) {
    delete modelCooldowns[modelName];
    return false;
  }
  return true;
}

function markModelCoolingDown(modelName: string, durationMs = 180000): void {
  modelCooldowns[modelName] = Date.now() + durationMs;
}

// ─── Primary: Groq ──────────────────────────────────────────────────────────────
async function callGroq(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  model = 'llama-3.3-70b-versatile'
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
    max_tokens: 450,
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
    params.tool_choice = 'auto';
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await groq.chat.completions.create({ ...params, stream: false } as any) as any;
    const choice = response.choices[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCalls = choice.message.tool_calls?.map((tc: any) => ({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
    }));

    let content = choice.message.content || '';
    content = content
      .replace(/<[a-zA-Z_0-9\-]+[^>]*>[\s\S]*?<\/[a-zA-Z_0-9\-]+>/gi, '')
      .replace(/<[a-zA-Z_0-9\-]+[^>]*>/gi, '')
      .replace(/<\/[a-zA-Z_0-9\-]+>/gi, '')
      .replace(/\{"(role|sectors|watchlist|portfolio|onboarding)"[\s\S]*?\}/gi, '')
      .trim();

    return {
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      provider: `groq (${model})`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate limit')) {
      markModelCoolingDown(model, 300000); // 5 min cooldown for rate-limited Groq models
    }
    throw err;
  }
}

// ─── Fallback: Gemini ───────────────────────────────────────────────────────────
async function callGemini(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  modelName = 'gemini-2.0-flash'
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
    const toolCalls = functionCalls?.map((fc) => ({
      name: fc.name,
      args: (fc.args || {}) as Record<string, unknown>,
    }));

    let text = '';
    try {
      text = result.response.text();
    } catch {
      text = '';
    }

    return {
      content: text,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      provider: `gemini (${modelName})`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
      markModelCoolingDown(modelName, 300000);
    }
    throw err;
  }
}

// ─── Groq Streaming Call ──────────────────────────────────────────────────────
async function callGroqStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  onChunk?: (text: string) => void,
  model = 'llama-3.3-70b-versatile'
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
    max_tokens: 450,
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
    params.tool_choice = 'auto';
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
          onChunk(fullContent);
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

    const toolCalls = Object.values(accumulatedToolCalls)
      .filter((tc) => tc.name.length > 0)
      .map((tc) => ({
        name: tc.name,
        args: JSON.parse(tc.argsStr || '{}') as Record<string, unknown>,
      }));

    let cleanedContent = fullContent
      .replace(/<[a-zA-Z_0-9\-]+[^>]*>[\s\S]*?<\/[a-zA-Z_0-9\-]+>/gi, '')
      .replace(/<[a-zA-Z_0-9\-]+[^>]*>/gi, '')
      .replace(/<\/[a-zA-Z_0-9\-]+>/gi, '')
      .replace(/\{"(role|sectors|watchlist|portfolio|onboarding)"[\s\S]*?\}/gi, '')
      .trim();

    return {
      content: cleanedContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      provider: `groq-stream (${model})`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate limit')) {
      markModelCoolingDown(model, 300000);
    }
    throw err;
  }
}

// ─── Public interface with 4-stage resilience fallback ───────────────────────
export async function chat(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  preferredModel?: string
): Promise<LLMResponse> {
  const targetModel = preferredModel || 'llama-3.3-70b-versatile';

  // Tier 1: Groq Primary (llama-3.3-70b-versatile)
  if (!isModelCoolingDown(targetModel)) {
    try {
      return await callGroq(messages, tools, targetModel);
    } catch (groqError1) {
      console.warn(`[LLM] Groq ${targetModel} failed:`, (groqError1 as Error).message);
    }
  }

  // Tier 2: Groq Instant (llama-3.1-8b-instant — 500,000 TPD limit)
  if (!isModelCoolingDown('llama-3.1-8b-instant')) {
    try {
      return await callGroq(messages, tools, 'llama-3.1-8b-instant');
    } catch (groqError2) {
      console.warn('[LLM] Groq 8B Instant failed:', (groqError2 as Error).message);
    }
  }

  // Tier 3: Gemini 2.0 Flash (1,500 RPD free tier quota)
  if (!isModelCoolingDown('gemini-2.0-flash')) {
    try {
      return await callGemini(messages, tools, 'gemini-2.0-flash');
    } catch (geminiError1) {
      console.warn('[LLM] Gemini 2.0 Flash failed:', (geminiError1 as Error).message);
    }
  }

  // Tier 4: Gemini 1.5 Flash Latest
  try {
    return await callGemini(messages, tools, 'gemini-1.5-flash-latest');
  } catch (finalError) {
    console.error('[LLM] All 4 provider models failed:', (finalError as Error).message);
    throw new Error('All AI model quotas are currently exhausted. Please try again in a few minutes.');
  }
}

// ─── Public interface for Streaming responses ───────────────────────────────
export async function chatStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  onChunk?: (text: string) => void,
  preferredModel?: string
): Promise<LLMResponse> {
  try {
    return await callGroqStream(messages, tools, onChunk, preferredModel);
  } catch {
    return await chat(messages, tools, preferredModel);
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
