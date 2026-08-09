import { getQuote } from '../src/tools/stockQuote';
import { getCompanyNews, getMarketNews } from '../src/tools/news';
import { getHistoricalReturn } from '../src/tools/yahooFinance';
import { selectOptimalModel, chatStream, ChatMessage } from '../src/orchestrator/llm';
import { buildSystemPrompt } from '../src/orchestrator/conversation';

async function runBenchmark() {
  console.log('⏱️ Running Atlas Performance & Latency Benchmark...\n');

  // 1. Check System Prompt Token Estimate
  const sysPrompt = buildSystemPrompt(null);
  const estTokens = Math.round(sysPrompt.length / 4);
  console.log(`1. System Prompt Size: ${sysPrompt.length} chars (~${estTokens} input tokens)`);

  // 2. Measure Data Source Tool Latencies
  console.log('\n2. Data Tool Latencies:');
  
  const tQuoteStart = Date.now();
  try {
    const q = await getQuote('LTC-USD');
    console.log(`   - getQuote('LTC-USD'): ${Date.now() - tQuoteStart}ms (${q.ticker} @ $${q.price})`);
  } catch (err) {
    console.log(`   - getQuote('LTC-USD') FAILED: ${(err as Error).message}`);
  }

  const tNewsStart = Date.now();
  try {
    const news = await getCompanyNews('LTC', 3);
    console.log(`   - getCompanyNews('LTC'): ${Date.now() - tNewsStart}ms (${news.length} items)`);
  } catch (err) {
    console.log(`   - getCompanyNews('LTC') FAILED: ${(err as Error).message}`);
  }

  const tHistStart = Date.now();
  try {
    const hist = await getHistoricalReturn('LTC', '1mo');
    console.log(`   - getHistoricalReturn('LTC'): ${Date.now() - tHistStart}ms`);
  } catch (err) {
    console.log(`   - getHistoricalReturn('LTC') FAILED: ${(err as Error).message}`);
  }

  // 3. Test Groq Model Response Speeds (8B vs 70B)
  console.log('\n3. Groq LLM Inference Latencies:');

  const testMessages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: 'how is LTC doing today?' },
  ];

  // Test 8B Instant
  const t8bStart = Date.now();
  try {
    const res8b = await chatStream(testMessages, undefined, undefined, 'llama-3.1-8b-instant', 300);
    console.log(`   - llama-3.1-8b-instant: ${Date.now() - t8bStart}ms (provider: ${res8b.provider})`);
  } catch (err) {
    console.log(`   - llama-3.1-8b-instant FAILED: ${(err as Error).message}`);
  }

  // Test 70B Versatile
  const t70bStart = Date.now();
  try {
    const res70b = await chatStream(testMessages, undefined, undefined, 'llama-3.3-70b-versatile', 300);
    console.log(`   - llama-3.3-70b-versatile: ${Date.now() - t70bStart}ms (provider: ${res70b.provider})`);
  } catch (err) {
    console.log(`   - llama-3.3-70b-versatile FAILED/RATE-LIMITED: ${(err as Error).message}`);
  }

  console.log('\n✅ Performance benchmark complete.');
  process.exit(0);
}

runBenchmark().catch((err) => {
  console.error('Benchmark Error:', err);
  process.exit(1);
});
