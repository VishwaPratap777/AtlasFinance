import { executeTool } from '../src/orchestrator/tools';

async function measure() {
  console.log('⏱ Measuring individual tool call latencies...\n');

  const tools = [
    { label: 'get_stock_quote (BTC)', name: 'get_stock_quote', args: { ticker: 'BTC' } },
    { label: 'get_company_news (BTC, 3d)', name: 'get_company_news', args: { ticker: 'BTC', days: '3' } },
    { label: 'get_price_history (BTC, 1mo)', name: 'get_price_history', args: { ticker: 'BTC', period: '1mo' } },
    { label: 'get_price_history (ETH-USD, 1mo)', name: 'get_price_history', args: { ticker: 'ETH-USD', period: '1mo' } },
    { label: 'get_price_history (SOL-USD, 1mo)', name: 'get_price_history', args: { ticker: 'SOL-USD', period: '1mo' } },
  ];

  for (const t of tools) {
    const start = Date.now();
    try {
      await executeTool(t.name, t.args, null, 1, async () => {});
      console.log(`• ${t.label}: ${Date.now() - start} ms`);
    } catch (err) {
      console.log(`• ${t.label} (ERROR): ${Date.now() - start} ms - ${(err as Error).message}`);
    }
  }

  // Measure total parallel time
  console.log('\n⏱ Measuring total parallel execution time for ALL 5 tools unconditionally...');
  const parallelStart = Date.now();
  await Promise.all(
    tools.map((t) => executeTool(t.name, t.args, null, 1, async () => {}))
  );
  console.log(`• Unconditional All-5 Parallel Execution Time: ${Date.now() - parallelStart} ms\n`);
}

measure();
