import { buildSystemPrompt } from '../src/orchestrator/conversation';

async function runTests() {
  console.log('🧪 Running Response Synthesis Quality Tests...\n');

  try {
    const sysPrompt = buildSystemPrompt(null);

    const requiredTokens = [
      'CORE REASONING HIERARCHY (3-Layer Pipeline)',
      'LAYER 1 — FACTUAL SNAPSHOT (MANDATORY)',
      'LAYER 2 — EVIDENCE-BASED INTERPRETATION (CONDITIONAL)',
      'FIND THE STRONGEST SIGNAL ACROSS TIMEFRAMES',
      'REGIME IS A CONCLUSION, NOT A TEMPLATE',
      'NEVER SAY "difficult to establish a clear interpretation"',
      'BANNED FILLER PHRASES',
      'Monitor X\'s price action and market sentiment closely',
      'may be a precursor to further price fluctuations',
      'NUMERICAL VERIFICATION & CONSISTENCY CHECK',
      'SIGNED NUMBERS RULE',
      'NEWS RELEVANCE GATE',
      'BREVITY IS NON-NEGOTIABLE',
      'PRE-SEND QUALITY CHECKLIST',
    ];

    for (const tok of requiredTokens) {
      if (!sysPrompt.includes(tok)) {
        console.error(`❌ FAIL: System prompt missing: "${tok}"`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: All reasoning, anti-filler, news-gate, and quality-checklist tokens present');

    // Verify "flat day + strong 30d" reference example is present
    if (!sysPrompt.includes('ETH is flat today at **$1,920.88**')) {
      console.error('❌ FAIL: Missing "flat day, strong 30d" reference example');
      process.exit(1);
    }
    console.log('✅ PASS: "Flat day, strong 30d" reference example present');

    // Verify "quiet asset" reference example is present
    if (!sysPrompt.includes('SOL at **$77.15**')) {
      console.error('❌ FAIL: Missing "quiet asset" reference example');
      process.exit(1);
    }
    console.log('✅ PASS: "Quiet asset, no news" reference example present');

    // Verify TOOL ERRORS ARE INVISIBLE rule is present
    if (!sysPrompt.includes('TOOL ERRORS ARE INVISIBLE')) {
      console.error('❌ FAIL: Missing TOOL ERRORS ARE INVISIBLE rule');
      process.exit(1);
    }
    console.log('✅ PASS: Tool error suppression rule present');

    console.log('\n🎉 ALL RESPONSE SYNTHESIS QUALITY TESTS PASSED!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL:', err);
    process.exit(1);
  }
}

runTests();
