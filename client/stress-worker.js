// stress-worker.js

self.onmessage = function(event) {
    if (event.data.type === 'START_BENCHMARK') {
        const durationMs = event.data.durationMs;
        const startTime = performance.now();
        let operationsCount = 0;
        
        // Sample floating-point operations matrix-style math
        let x = 0.0001;
        
        while (performance.now() - startTime < durationMs) {
            // Unrolling loops slightly increases pure compute stress per iteration
            x = Math.sin(x) * 1.00001 + Math.cos(x) * 0.00001;
            x = Math.sqrt(x * x + 0.00001);
            operationsCount += 5; // Track total operations completed
        }

        const actualDuration = (performance.now() - startTime) / 1000; // in seconds
        const opsPerSecond = Math.floor(operationsCount / actualDuration);

        self.postMessage({
            type: 'BENCHMARK_COMPLETE',
            opsPerSecond: opsPerSecond
        });
    }
};