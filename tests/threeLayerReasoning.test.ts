import { buildSystemPrompt } from '../src/orchestrator/conversation';

async function runTests() {
  console.log('🧪 Running Data-Integrity & Telegram Scannable Format Tests...\n');

  try {
    const sysPrompt = buildSystemPrompt(null);

    const requiredTokens = [
      'CORE REASONING HIERARCHY (3-Layer Pipeline)',
      'LAYER 1 — FACTUAL SNAPSHOT (MANDATORY)',
      'LAYER 2 — EVIDENCE-BASED INTERPRETATION (CONDITIONAL)',
      'DATA INTEGRITY & ZERO METRIC LEAKAGE (MANDATORY)',
      'Strict Asset-Metric Isolation',
      'Independent Record Construction',
      'Fresh Tool Data Primacy',
      'No Cross-Asset Data Reuse',
      'Equivalent Timeframes',
      'TELEGRAM-FRIENDLY SCANNABLE ANALYST BRIEFING',
      'BANNED FILLER PHRASES',
      'SIGNED NUMBERS RULE',
      'NEWS RELEVANCE GATE',
      'PRE-SEND DATA INTEGRITY & QUALITY CHECKLIST',
    ];

    for (const tok of requiredTokens) {
      if (!sysPrompt.includes(tok)) {
        console.error(`❌ FAIL: System prompt missing token: "${tok}"`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: All Data Integrity, Telegram scannable format, and quality-checklist tokens present');

    // Verify LTC scannable reference example is present
    if (!sysPrompt.includes('LTC is showing strong medium-term performance despite a quiet session.')) {
      console.error('❌ FAIL: Missing LTC scannable reference example');
      process.exit(1);
    }
    console.log('✅ PASS: LTC scannable reference example present');

    // Verify TOOL ERRORS ARE INVISIBLE rule is present
    if (!sysPrompt.includes('TOOL ERRORS ARE INVISIBLE')) {
      console.error('❌ FAIL: Missing TOOL ERRORS ARE INVISIBLE rule');
      process.exit(1);
    }
    console.log('✅ PASS: Tool error suppression rule present');

    console.log('\n🎉 ALL DATA INTEGRITY AND REASONING TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL:', err);
    process.exit(1);
  }
}

runTests();
