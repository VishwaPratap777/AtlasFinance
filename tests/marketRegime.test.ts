import { getQuote, formatQuote, QuoteResult } from '../src/tools/stockQuote';
import { buildSystemPrompt } from '../src/orchestrator/conversation';

async function runMarketRegimeTests() {
  console.log('🧪 Running Market Regime & Reasoning Layer Tests...\n');

  // Test 1: formatQuote formats volume correctly when present
  const mockQuote: QuoteResult = {
    ticker: 'LTC-USD',
    price: 46.21,
    change: 0.23,
    changePercent: 0.50,
    high: 46.50,
    low: 45.80,
    open: 45.98,
    previousClose: 45.98,
    volume: 126450000,
    timestamp: new Date().toISOString(),
  };

  const formatted = formatQuote(mockQuote);
  console.log('Formatted Quote Output:\n', formatted);

  if (!formatted.includes('• 24h Volume: ~$126.5M')) {
    console.error('❌ FAIL: formatQuote did not contain expected formatted volume "• 24h Volume: ~$126.5M"');
    process.exit(1);
  }
  console.log('✅ PASS: formatQuote correctly formats 24h Volume');

  // Test 2: System prompt contains Market Regime & Why It Matters guidelines
  try {
    const sysPrompt = buildSystemPrompt(null);

    const requiredTokens = [
      'MARKET REGIME / PATTERN',
      'WHY IT MATTERS',
      'consolidation',
      'relative strength',
      'insufficient evidence',
      'STRICT REGIME & CAUSAL SAFETY',
    ];

    for (const tok of requiredTokens) {
      if (!sysPrompt.includes(tok)) {
        console.error(`❌ FAIL: System prompt missing required market regime token: "${tok}"`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: System prompt includes all Market Regime and "Why It Matters" instructions');
  } catch (err) {
    console.error('❌ FAIL: Exception while building system prompt:', err);
    process.exit(1);
  }

  // Test 3: getQuote('LTC') returns price quote with ticker LTC-USD
  try {
    const ltcQuote = await getQuote('LTC');
    console.log('\nLive Quote Result for "LTC":', JSON.stringify(ltcQuote, null, 2));

    if (ltcQuote.ticker !== 'LTC-USD') {
      console.error(`❌ FAIL: Expected ticker "LTC-USD", got "${ltcQuote.ticker}"`);
      process.exit(1);
    }
    console.log('✅ PASS: getQuote("LTC") resolved to "LTC-USD" with volume/quote details');

    console.log('\n🎉 ALL MARKET REGIME TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL: Exception during getQuote("LTC"):', err);
    process.exit(1);
  }
}

runMarketRegimeTests();
