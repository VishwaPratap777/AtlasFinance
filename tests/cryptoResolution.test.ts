import { getQuote, KNOWN_CRYPTO } from '../src/tools/stockQuote';

async function runTests() {
  console.log('🧪 Running Crypto Ticker Resolution Tests...\n');

  // Test 1: KNOWN_CRYPTO contains BNB
  if (!KNOWN_CRYPTO.has('BNB') || !KNOWN_CRYPTO.has('BNB-USD')) {
    console.error('❌ FAIL: BNB is not in KNOWN_CRYPTO set!');
    process.exit(1);
  }
  console.log('✅ PASS: BNB and BNB-USD exist in KNOWN_CRYPTO');

  // Test 2: getQuote('BNB') returns crypto data (BNB-USD) with sane price range (~$600, >$100 & <$2000)
  try {
    const res = await getQuote('BNB');
    console.log(`\nQuote Result for "BNB":`, JSON.stringify(res, null, 2));

    if (res.ticker !== 'BNB-USD') {
      console.error(`❌ FAIL: Ticker resolved to "${res.ticker}" instead of "BNB-USD"!`);
      process.exit(1);
    }
    console.log('✅ PASS: Ticker correctly resolved to "BNB-USD"');

    if (res.price < 100 || res.price > 2000) {
      console.error(`❌ FAIL: BNB price $${res.price} is outside sane crypto range ($100 - $2000)! Likely resolved to wrong equity symbol.`);
      process.exit(1);
    }
    console.log(`✅ PASS: BNB price $${res.price} is within sane cryptocurrency range ($100 - $2000)`);

    console.log('\n🎉 ALL CRYPTO RESOLUTION TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL: Exception during getQuote("BNB"):', err);
    process.exit(1);
  }
}

runTests();
