import { extractQuoteTickers, detectQuoteIntent } from '../src/tools/stockQuote';

function determineToolsForQuery(userText: string): string[] {
  const quoteTickers = extractQuoteTickers(userText);
  const isQuoteAsk = quoteTickers.length > 0 || detectQuoteIntent(userText);
  if (!isQuoteAsk || quoteTickers.length === 0) return [];

  const isCompareAsk = /\b(compare|versus|vs|difference|or)\b/i.test(userText);
  const isEarningsAsk = /\b(earnings|quarterly|eps|revenue|guidance|report|results|surprise|calendar)\b/i.test(userText);
  const isMoveAsk = /\b(why|cause|reason|dump\w*|pump\w*|fall\w*|ris\w*|crash\w*|spik\w*|mov\w*|drop\w*|gain\w*)\b/i.test(userText);
  const isPatternAsk = /\b(pattern\w*|trend\w*|technical|support|resistance|breakout\w*|consolidat\w*|momentum|30-?day|monthly|chart)\b/i.test(userText);

  const wordCount = userText.trim().split(/\s+/).length;
  const isSimplePrice = !isCompareAsk && !isEarningsAsk && !isMoveAsk && !isPatternAsk &&
    (wordCount <= 4 || /\b(price|quote|worth|cost|value|level|\$[A-Z]+)\b/i.test(userText)) &&
    !/\b(how('s|\s+is)|what('s|\s+is)|news|update|why)\b/i.test(userText);

  const toolCalls: string[] = [];

  for (const rawTicker of quoteTickers) {
    toolCalls.push(`get_stock_quote(${rawTicker})`);

    if (isSimplePrice) continue;

    toolCalls.push(`get_company_news(${rawTicker})`);

    if (isPatternAsk || isCompareAsk) {
      toolCalls.push(`get_price_history(${rawTicker})`);
    }
  }

  return toolCalls;
}

async function runTests() {
  console.log('🧪 Running Intent-Aware Tool Selection Tests...\n');

  // Test Case 1: Simple Price Ask -> expects ONLY get_stock_quote
  const t1 = determineToolsForQuery('BTC price');
  console.log('Query: "BTC price" -> Tools:', t1);
  if (t1.length !== 1 || !t1[0].startsWith('get_stock_quote')) {
    console.error('❌ FAIL: "BTC price" did not select quote-only!');
    process.exit(1);
  }
  console.log('✅ PASS: Simple price ask selects quote-only (fast path)');

  // Test Case 2: General Update / "How's BTC doing?" -> expects quote + news
  const t2 = determineToolsForQuery("How's BTC doing?");
  console.log('Query: "How\'s BTC doing?" -> Tools:', t2);
  if (t2.length !== 2 || !t2[1].startsWith('get_company_news')) {
    console.error('❌ FAIL: General update did not select quote + news!');
    process.exit(1);
  }
  console.log('✅ PASS: General update selects quote + news');

  // Test Case 3: Pattern / Trend Ask -> expects quote + news + price history
  const t3 = determineToolsForQuery('Is BTC consolidating?');
  console.log('Query: "Is BTC consolidating?" -> Tools:', t3);
  if (t3.length !== 3 || !t3[2].startsWith('get_price_history')) {
    console.error('❌ FAIL: Pattern query did not select price history!');
    process.exit(1);
  }
  console.log('✅ PASS: Pattern ask selects targeted historical data');

  console.log('\n🎉 ALL INTENT-AWARE TOOL SELECTION TESTS PASSED!');
}

runTests();
