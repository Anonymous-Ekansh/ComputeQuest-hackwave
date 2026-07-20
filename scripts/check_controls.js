const fetch = require('node-fetch'); // We can use native fetch in Node 18+, but let's be safe if they use 16. Actually, let's use global fetch for Node 18+.

async function main() {
  try {
    // Try to use global fetch if available (Node 18+)
    const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
    const res = await fetchFn('http://localhost:3001/api/screening/controls-check');
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    
    console.log("=== COMPUTEQUEST CONTROL MOLECULE CHECK ===\n");
    console.log(`Total Scored Molecules: ${data.totalScored}`);
    console.log(`Decoy Median Affinity: ${data.decoyMedian ? data.decoyMedian.toFixed(2) : 'N/A'} kcal/mol`);
    console.log(`Decoy Mean Affinity: ${data.decoyMean ? data.decoyMean.toFixed(2) : 'N/A'} kcal/mol\n`);
    
    if (!data.controls || data.controls.length === 0) {
      console.log("No controls have been scored yet! Waiting for nodes to dock them.");
      return;
    }
    
    for (const ctrl of data.controls) {
      console.log(`- ${ctrl.name}:`);
      console.log(`  Rank: #${ctrl.rank} of ${data.totalScored}`);
      console.log(`  Affinity: ${ctrl.affinity.toFixed(2)} kcal/mol`);
      console.log(`  Verdict: ${ctrl.verdict}\n`);
    }
    
  } catch (err) {
    console.error("Failed to run check. Make sure the server is running on port 3001.");
    console.error(err.message);
  }
}

main();
