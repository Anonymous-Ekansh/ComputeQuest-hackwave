/**
 * server/src/consensus.js — Consensus verification for distributed screening
 *
 * Core principle: no single node's result counts on its own.
 * A molecule's score only becomes real once independent nodes agree.
 *
 * Functions:
 *   checkConsensus(chunkResults)  — 2-of-k agreement check
 *   isTimingPlausible(ms, count) — reject suspiciously fast results
 *   updateReputation(supabase, userId, agreed) — track node reliability
 */

const {
  CONSENSUS_K,
  CONSENSUS_TOLERANCE,
  MIN_COMPUTE_MS_PER_MOLECULE,
} = require('../../shared/constants');

/**
 * Check consensus across k node results for a chunk.
 *
 * For each molecule, takes the score from each node and checks if
 * at least 2 of k are within ±CONSENSUS_TOLERANCE of each other.
 *
 * @param {Array<{nodeUserId: string, scores: Array<{smiles: string, similarity: number}>}>} chunkResults
 * @returns {{
 *   passed: boolean,
 *   acceptedScores: Array<{smiles: string, similarity: number, agreementCount: number}> | null,
 *   agreedNodeIds: string[],
 *   disagreedNodeIds: string[],
 *   details: string
 * }}
 */
function checkConsensus(chunkResults) {
  if (!chunkResults || chunkResults.length < 2) {
    return {
      passed: false,
      acceptedScores: null,
      agreedNodeIds: [],
      disagreedNodeIds: chunkResults ? chunkResults.map(r => r.nodeUserId) : [],
      details: `Need at least 2 results, got ${chunkResults ? chunkResults.length : 0}`,
    };
  }

  // Use the first result's molecule list as reference
  const moleculeCount = chunkResults[0].scores.length;
  const acceptedScores = [];
  let totalAgreed = 0;
  let totalDisagreed = 0;

  // Track which nodes agreed per-molecule
  const nodeAgreementCounts = {};
  for (const r of chunkResults) {
    nodeAgreementCounts[r.nodeUserId] = 0;
  }

  for (let molIdx = 0; molIdx < moleculeCount; molIdx++) {
    // Gather scores from all nodes for this molecule
    const nodeScores = chunkResults.map(r => ({
      nodeUserId: r.nodeUserId,
      score: r.scores[molIdx] ? r.scores[molIdx].similarity : null,
      smiles: r.scores[molIdx] ? r.scores[molIdx].smiles : null,
    })).filter(s => s.score !== null && s.score !== undefined);

    if (nodeScores.length < 2) {
      // Not enough valid scores for this molecule
      acceptedScores.push({
        smiles: chunkResults[0].scores[molIdx]?.smiles || 'unknown',
        similarity: null,
        agreementCount: 0,
      });
      totalDisagreed++;
      continue;
    }

    // Find the largest subset of nodes whose scores are all within tolerance
    // Simple approach: check all pairs, find the best cluster
    let bestCluster = [];
    let bestMedian = 0;

    // Sort scores to find close groups efficiently
    const sorted = [...nodeScores].sort((a, b) => a.score - b.score);

    for (let i = 0; i < sorted.length; i++) {
      const cluster = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        if (Math.abs(sorted[j].score - sorted[i].score) <= CONSENSUS_TOLERANCE * 2) {
          cluster.push(sorted[j]);
        }
      }
      if (cluster.length > bestCluster.length) {
        bestCluster = cluster;
        // Median of cluster
        const mid = Math.floor(cluster.length / 2);
        bestMedian = cluster[mid].score;
      }
    }

    if (bestCluster.length >= 2) {
      // Consensus reached for this molecule
      totalAgreed++;
      for (const node of bestCluster) {
        nodeAgreementCounts[node.nodeUserId]++;
      }
      acceptedScores.push({
        smiles: bestCluster[0].smiles,
        similarity: Math.round(bestMedian * 10000) / 10000,
        agreementCount: bestCluster.length,
      });
    } else {
      totalDisagreed++;
      acceptedScores.push({
        smiles: nodeScores[0].smiles,
        similarity: null,
        agreementCount: 0,
      });
    }
  }

  // Chunk passes consensus if ≥80% of molecules have agreement
  const agreementRatio = moleculeCount > 0 ? totalAgreed / moleculeCount : 0;
  const passed = agreementRatio >= 0.8;

  // Determine which nodes agreed vs disagreed
  const threshold = moleculeCount * 0.5; // node agreed if it was in the consensus cluster for >50% of molecules
  const agreedNodeIds = [];
  const disagreedNodeIds = [];
  for (const [nodeId, count] of Object.entries(nodeAgreementCounts)) {
    if (count >= threshold) {
      agreedNodeIds.push(nodeId);
    } else {
      disagreedNodeIds.push(nodeId);
    }
  }

  return {
    passed,
    acceptedScores: passed ? acceptedScores.filter(s => s.similarity !== null) : null,
    agreedNodeIds,
    disagreedNodeIds,
    details: `${totalAgreed}/${moleculeCount} molecules agreed (${(agreementRatio * 100).toFixed(1)}%), ${agreedNodeIds.length} nodes in consensus`,
  };
}

/**
 * Check if a node's compute time is plausible for the given chunk size.
 * Rejects suspiciously fast results that suggest the node faked inference.
 *
 * @param {number} wallClockMs - reported compute time
 * @param {number} moleculeCount - number of molecules in the chunk
 * @returns {{ plausible: boolean, reason: string }}
 */
function isTimingPlausible(wallClockMs, moleculeCount) {
  const minExpectedMs = moleculeCount * MIN_COMPUTE_MS_PER_MOLECULE;

  if (wallClockMs < minExpectedMs) {
    return {
      plausible: false,
      reason: `Suspiciously fast: ${wallClockMs}ms for ${moleculeCount} molecules (min expected: ${minExpectedMs}ms)`,
    };
  }

  return { plausible: true, reason: 'ok' };
}

/**
 * Update a node's reputation based on whether it agreed with consensus.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient | null} supabase
 * @param {string} userId
 * @param {boolean} agreed - whether this node was in the consensus cluster
 */
async function updateReputation(supabase, userId, agreed) {
  if (!supabase || !userId) return;

  try {
    // Fetch current reputation
    const { data: existing } = await supabase
      .from('node_reputation')
      .select('*')
      .eq('user_id', userId)
      .single();

    const totalSubmitted = (existing?.total_chunks_submitted || 0) + 1;
    const totalAgreed = (existing?.total_chunks_agreed || 0) + (agreed ? 1 : 0);
    const agreementRate = totalSubmitted > 0 ? totalAgreed / totalSubmitted : 1.0;

    // Reputation multiplier: drops below 1.0 if agreement rate is poor
    // Full credit if rate >= 0.9, linear decay to 0.5 at rate = 0.5, floor at 0.5
    let reputationMultiplier = 1.0;
    if (agreementRate < 0.9) {
      reputationMultiplier = Math.max(0.5, 0.5 + (agreementRate - 0.5) * (0.5 / 0.4));
    }

    await supabase
      .from('node_reputation')
      .upsert({
        user_id: userId,
        total_chunks_submitted: totalSubmitted,
        total_chunks_agreed: totalAgreed,
        agreement_rate: Math.round(agreementRate * 10000) / 10000,
        reputation_multiplier: Math.round(reputationMultiplier * 10000) / 10000,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'user_id' });

  } catch (err) {
    console.error(`[consensus] Failed to update reputation for ${userId}:`, err.message);
  }
}

/**
 * Get a node's current reputation multiplier.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient | null} supabase
 * @param {string} userId
 * @returns {Promise<number>} reputation multiplier (default 1.0)
 */
async function getReputationMultiplier(supabase, userId) {
  if (!supabase || !userId) return 1.0;

  try {
    const { data } = await supabase
      .from('node_reputation')
      .select('reputation_multiplier')
      .eq('user_id', userId)
      .single();

    return data?.reputation_multiplier ?? 1.0;
  } catch {
    return 1.0;
  }
}

module.exports = {
  checkConsensus,
  isTimingPlausible,
  updateReputation,
  getReputationMultiplier,
};
