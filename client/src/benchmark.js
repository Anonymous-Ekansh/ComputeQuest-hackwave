// benchmark.js

// Note: This benchmark is currently for frontend display ONLY. 
// Integration into server-side task allocation logic is planned for a later stage.
export async function runDeviceBenchmark() {
    console.log("Starting hardware evaluation...");

    // 1. Detect Logical CPU Cores
    const logicalCores = navigator.hardwareConcurrency || 2;
    console.log(`Detected CPU Cores: ${logicalCores}`);

    // 2. Measure Network Latency (Ping)
    const latency = await measureNetworkLatency();
    console.log(`Network Latency: ${latency.toFixed(1)}ms`);

    // 3. Run the FLOPS Stress Test via a Web Worker
    const computeScore = await runStressTest();
    console.log(`Compute Score (Operations/sec): ${computeScore}`);

    // 4. Calculate Optimal Chunk Size to combat transmission loss
    // High latency needs larger chunks to balance the network overhead
    const optimalChunkSize = Math.floor((computeScore * (latency / 1000)) * 1.5);

    return {
        cores: logicalCores,
        latency: latency,
        computeScore: computeScore,
        optimalChunkSize: Math.max(optimalChunkSize, 10000) // minimum threshold
    };
}

function measureNetworkLatency() {
    return new Promise((resolve) => {
        const start = performance.now();
        // Replacing with your actual WebSocket ping or server health endpoint
        const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
        fetch(serverUrl + '/', { cache: 'no-store' })
            .then(() => {
                const duration = performance.now() - start;
                resolve(duration);
            })
            .catch(() => {
                // Fallback estimate if local dev server doesn't have a endpoint yet
                resolve(50); 
            });
    });
}

function runStressTest() {
    return new Promise((resolve) => {
        // Create a worker from our worker file (Vite module syntax)
        const worker = new Worker(new URL('./workers/stress-worker.js', import.meta.url), { type: 'module' });
        
        // Start the test
        worker.postMessage({ type: 'START_BENCHMARK', durationMs: 2000 });

        worker.onmessage = (event) => {
            if (event.data.type === 'BENCHMARK_COMPLETE') {
                const opsPerSecond = event.data.opsPerSecond;
                worker.terminate(); // Clean up thread immediately
                resolve(opsPerSecond);
            }
        };
    });
}