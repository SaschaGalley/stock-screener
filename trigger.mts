import { pipeline } from './src/hatchet/tasks/pipeline.js';
const t0 = Date.now();
const out = await pipeline.run({ trigger: 'manual', symbols: ['AAPL', 'MSFT', 'NVDA'] });
console.log(`RESULT nach ${((Date.now()-t0)/1000).toFixed(0)}s: ${JSON.stringify(out)}`);
