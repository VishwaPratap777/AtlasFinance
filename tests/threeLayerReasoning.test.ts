import { buildSystemPrompt } from '../src/orchestrator/conversation';

async function runThreeLayerReasoningTests() {
  console.log('🧪 Running 3-Layer Financial Reasoning & Data-Grounded Synthesis Tests...\n');

  try {
    const sysPrompt = buildSystemPrompt(null);

    const requiredTokens = [
      'CORE REASONING HIERARCHY (3-Layer Pipeline)',
      'LAYER 1 — FACTUAL SNAPSHOT (MANDATORY)',
      'LAYER 2 — EVIDENCE-BASED INTERPRETATION (CONDITIONAL)',
      'LAYER 3 — WHY IT MATTERS / NEXT STEP (OPTIONAL)',
      'MARKET REGIME IS A CONCLUSION, NOT A MANDATORY TEMPLATE',
      'NUMERICAL VERIFICATION & CONSISTENCY CHECK (MANDATORY BEFORE WRITING)',
      'CAUSALITY & NEWS CALIBRATION',
      'NEWS RELEVANCE GATE',
      'BREVITY IS NON-NEGOTIABLE',
      'SIGNED NUMBERS RULE',
    ];

    for (const tok of requiredTokens) {
      if (!sysPrompt.includes(tok)) {
        console.error(`❌ FAIL: System prompt missing required token: "${tok}"`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: System prompt includes all 3-Layer Reasoning, News Gate, and Brevity instructions');

    // Check that concise SOL reference example is present
    if (!sysPrompt.includes('SOL is at **$23.15**')) {
      console.error('❌ FAIL: System prompt missing concise SOL reference example');
      process.exit(1);
    }
    console.log('✅ PASS: System prompt includes concise SOL reference example');

    // Check that TOOL ERRORS ARE INVISIBLE rule is present
    if (!sysPrompt.includes('TOOL ERRORS ARE INVISIBLE')) {
      console.error('❌ FAIL: System prompt missing TOOL ERRORS ARE INVISIBLE rule');
      process.exit(1);
    }
    console.log('✅ PASS: System prompt includes tool error suppression rule');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL: Exception during system prompt verification:', err);
    process.exit(1);
  }
}

runThreeLayerReasoningTests();
