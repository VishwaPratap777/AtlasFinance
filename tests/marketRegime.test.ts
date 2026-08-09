import { formatQuote, QuoteResult } from '../src/tools/stockQuote';
import { buildSystemPrompt } from '../src/orchestrator/conversation';
import { executeTool } from '../src/orchestrator/tools';

async function runCalibrationTests() {
  console.log('🧪 Running Market Regime & Calibration Tests...\n');

  // Test 1: formatQuote includes 24h volume formatting
  const mockQuote: QuoteResult = {
    ticker: 'LTC-USD',
    price: 46.21,
    change: 0.23,
    changePercent: 0.50,
    high: 46.80,
    low: 45.90,
    open: 45.98,
    previousClose: 45.98,
    volume: 126000000,
    timestamp: new Date().toISOString(),
  };

  const formatted = formatQuote(mockQuote);
  console.log('Formatted Quote Output:\n', formatted);

  if (!formatted.includes('24h Volume') || !formatted.includes('126')) {
    console.error('❌ FAIL: formatQuote did not render 24h volume correctly!');
    process.exit(1);
  }
  console.log('✅ PASS: formatQuote renders 24h volume correctly');

  // Test 2: System prompt contains mandatory calibration & correlation rules
  const sysMsg = buildSystemPrompt(null);

  if (!sysMsg.includes('Recent ETF inflows provide a positive institutional-demand signal.')) {
    console.error('❌ FAIL: System prompt missing mandatory ETF inflow calibration rule!');
    process.exit(1);
  }
  console.log('✅ PASS: ETF inflow calibration rule present in system prompt');

  if (!sysMsg.includes('Relevant context')) {
    console.error('❌ FAIL: System prompt missing "Relevant context" labelling distinction!');
    process.exit(1);
  }
  console.log('✅ PASS: "Relevant context" vs "Catalyst" label rule present in system prompt');

  if (!sysMsg.includes('Do NOT turn correlation into causation')) {
    console.error('❌ FAIL: System prompt missing correlation vs causation rule!');
    process.exit(1);
  }
  console.log('✅ PASS: Correlation vs causation rule present in system prompt');

  // Test 3: Entity Disambiguation for LTC
  const profileRes = await executeTool(
    'get_company_profile',
    { ticker: 'LTC' },
    null,
    12345,
    async () => {}
  );
  console.log('\nEntity Profile Result for "LTC":\n', profileRes);

  if (!profileRes.includes('decentralized cryptocurrency') || profileRes.includes('LTC Properties')) {
    console.error('❌ FAIL: Entity disambiguation failed! Returned corporate profile for crypto LTC.');
    process.exit(1);
  }
  console.log('✅ PASS: Entity disambiguation correctly blocked LTC Properties for crypto LTC');

  console.log('\n🎉 ALL CALIBRATION & MARKET REGIME TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runCalibrationTests().catch((err) => {
  console.error('❌ FAIL: Unexpected error running tests:', err);
  process.exit(1);
});
