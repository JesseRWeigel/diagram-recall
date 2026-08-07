/**
 * The Hungarian (Kuhn and Munkres) algorithm for the linear sum assignment problem, in the
 * O(n^3) shortest augmenting path form with dual potentials.
 *
 * This is used by one thing only: the bipartite approximation of graph edit distance in
 * `score.js`. It solves the assignment problem exactly. The approximation is in what the cost
 * matrix contains, not in how it is solved.
 */

/** A stand in for infinity that stays a finite number, so the potentials never become NaN. */
export const BLOCKED = 1e9;

/**
 * @param {number[][]} cost square matrix, cost[i][j] to assign row i to column j
 * @returns {{assignment: number[], total: number}} assignment[i] is the column chosen for row i
 */
export function hungarian(cost) {
  const n = cost.length;
  if (n === 0) return { assignment: [], total: 0 };
  for (const row of cost) {
    if (row.length !== n) throw new Error('hungarian() needs a square cost matrix');
  }

  // One based internal arrays, which is what makes the classic formulation readable.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1).fill(0);
  const way = new Int32Array(n + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= n; j += 1) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  let total = 0;
  for (let i = 0; i < n; i += 1) total += cost[i][assignment[i]];
  return { assignment, total };
}
