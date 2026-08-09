import { buildSystemPrompt } from '../src/orchestrator/conversation';

async function runTests() {
  console.log('🧪 Running Telegram-Friendly Scannable Format & Quality Tests...\n');

  try {
    const sysPrompt = buildSystemPrompt(null);

    const requiredTokens = [
      'CORE REASONING HIERARCHY (3-Layer Pipeline)',
      'LAYER 1 — FACTUAL SNAPSHOT (MANDATORY)',
      'LAYER 2 — EVIDENCE-BASED INTERPRETATION (CONDITIONAL)',
      'FIND THE STRONGEST SIGNAL ACROSS TIMEFRAMES',
      'TELEGRAM-FRIENDLY SCANNABLE ANALYST BRIEFING',
      'FORMATTING & STRUCTURE (VISUALLY SCANNABLE & CONCISE)',
      'BANNED FILLER PHRASES',
      'Monitor X\'s price action and market sentiment closely',
      'may be a precursor to further price fluctuations',
      'NUMERICAL VERIFICATION & CONSISTENCY CHECK',
      'SIGNED NUMBERS RULE',
      'NEWS RELEVANCE GATE',
      'PRE-SEND QUALITY CHECKLIST',
    ];

    for (const tok of requiredTokens) {
      if (!sysPrompt.includes(tok)) {
        console.error(`❌ FAIL: System prompt missing token: "${tok}"`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: All reasoning, Telegram scannable format, news-gate, and quality-checklist tokens present');

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

    console.log('\n🎉 ALL FORMATTING AND REASONING TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL:', err);
    process.exit(1);
  }
}

runTests();
