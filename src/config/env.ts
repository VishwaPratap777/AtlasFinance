import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),

  // AI Providers
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  GEMINI_API_KEY: z.string().optional().default(''),
  JINA_API_KEY: z.string().optional().default(''),
  AGENT_ROUTER_API_KEY: z.string().optional().default(''),
  AGENT_ROUTER_BASE_URL: z.string().optional().default('https://agentrouter.org/v1'),

  // Financial Data
  FINNHUB_API_KEY: z.string().optional().default(''),
  ALPHA_VANTAGE_API_KEY: z.string().optional().default(''),

  // Database & Cache
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  REDIS_URL: z.string().optional().default(''),

  // Google OAuth (optional)
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),

  // Server
  PORT: z.string().default('3000').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  WEBHOOK_URL: z.string().optional().default(''),
  WEBHOOK_SECRET: z.string().optional().default('atlas_webhook_secret'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
