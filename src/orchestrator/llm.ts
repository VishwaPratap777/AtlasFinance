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

// ─── Primary: Groq ──────────────────────────────────────────────────────────────
async function callGroq(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  model = 'llama-3.3-70b-versatile'
): Promise<LLMResponse> {
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
    provider: 'groq',
  };
}

// ─── Fallback: Gemini ───────────────────────────────────────────────────────────
async function callGemini(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  modelName = 'gemini-1.5-flash'
): Promise<LLMResponse> {
  if (!gemini) throw new Error('Gemini API key not configured');

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
}

// ─── Public interface with 4-stage resilience fallback ───────────────────────
export async function chat(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  preferredModel?: string
): Promise<LLMResponse> {
  // Tier 1: Groq Primary 70B (llama-3.3-70b-versatile)
  try {
    return await callGroq(messages, tools, preferredModel || 'llama-3.3-70b-versatile');
  } catch (groqError1) {
    console.warn('[LLM] Groq 70B rate-limited, trying Groq 8B Instant (500k TPD quota):', (groqError1 as Error).message);
    
    // Tier 2: Groq High-Capacity Instant (llama-3.1-8b-instant — 500,000 tokens/day limit!)
    try {
      return await callGroq(messages, tools, 'llama-3.1-8b-instant');
    } catch (groqError2) {
      console.warn('[LLM] Groq 8B failed, trying Gemini 1.5 Flash (1500 RPD quota):', (groqError2 as Error).message);
      
      // Tier 3: Gemini 1.5 Flash (1,500 requests/day free tier quota)
      try {
        return await callGemini(messages, tools, 'gemini-1.5-flash');
      } catch (geminiError1) {
        console.warn('[LLM] Gemini 1.5 Flash failed, trying Gemini 2.5 Flash:', (geminiError1 as Error).message);
        
        // Tier 4: Gemini 2.5 Flash
        try {
          return await callGemini(messages, tools, 'gemini-2.5-flash');
        } catch (finalError) {
          console.error('[LLM] All 4 provider models failed:', (finalError as Error).message);
          throw new Error('All AI model quotas are currently exhausted. Please try again in a few minutes.');
        }
      }
    }
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
