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
      'PROSE STRUCTURE (NO FORCED SECTION TITLES)',
    ];

    for (const tok of requiredTokens) {
      if (!sysPrompt.includes(tok)) {
        console.error(`❌ FAIL: System prompt missing required 3-layer reasoning token: "${tok}"`);
        process.exit(1);
      }
    }
    console.log('✅ PASS: System prompt includes all 3-Layer Reasoning Hierarchy & Anti-Forced-Regime instructions');

    // Check that Solana inconclusive regime reference example is present in system prompt
    if (!sysPrompt.includes('Solana is trading at $23.15, down 5.8% over the past 30 days')) {
      console.error('❌ FAIL: System prompt missing Solana inconclusive regime reference example');
      process.exit(1);
    }
    console.log('✅ PASS: System prompt includes Solana inconclusive regime reference example');

    console.log('\n🎉 ALL 3-LAYER FINANCIAL REASONING TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL: Exception during system prompt verification:', err);
    process.exit(1);
  }
}

runThreeLayerReasoningTests();
