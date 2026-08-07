/**
 * Scoring a reconstructed diagram against its reference.
 *
 * ## What is computed, and how exact it is
 *
 * The quantity is a graph edit distance under a unit cost model, with one addition to the
 * textbook operation set that is explained below. Graph edit distance is NP-hard in general,
 * because the node correspondence has to be searched. This module has three paths and it always
 * says which one it took, in `result.algorithm`, `result.exact` and `result.bound`.
 *
 *   identity   Every node in the attempt carries an identifier that exists in the reference.
 *              That is the situation the drill creates: the learner is handed the reference's
 *              own node tokens and places them, so the correspondence is given rather than
 *              inferred. No search happens. Exact, O(V + E log E).
 *
 *   exact      The identifiers differ, so the correspondence has to be found. A depth first
 *              branch and bound assigns reference nodes to attempt nodes one at a time,
 *              pruning any branch whose already committed cost has reached the best complete
 *              answer so far. The bound is admissible because committed cost never decreases
 *              as more nodes are decided. Exact, worst case O(n! * E), which is why it is
 *              capped at LIMITS.exactNodes nodes and at LIMITS.expansionBudget expansions.
 *
 *   approx     Above that cap, the correspondence comes from the bipartite assignment
 *              heuristic of Riesen and Bunke: build a cost matrix whose entries are node
 *              substitution cost plus the cost of matching the two nodes' incident edge sets,
 *              solve it exactly with the Hungarian algorithm in O(n^3), then measure the real
 *              edit cost of the correspondence it returns. The result is a valid edit script,
 *              so it is an UPPER BOUND on the true distance and never below it. It is reported
 *              with `exact: false` and `bound: 'upper'`.
 *
 * Above LIMITS.approxNodes nodes the module throws GraphTooLarge rather than working for an
 * unbounded time. Nothing here degrades quietly.
 *
 * ## The cost model
 *
 * Every difference costs 1 and is placed in exactly one of four buckets.
 *
 *   structure  Which nodes exist, which pairs are related, and which way each relation points.
 *   label      The words on a node or on a link.
 *   style      Node shape, link line style, and the decoration on a link head.
 *   grouping   Which subgraph a node sits in.
 *
 * Structure and label are reported separately because they mean different things about what
 * the learner understood. A reconstruction with the right shape and one link labelled wrongly
 * has the model and has misremembered a word. A reconstruction with the wrong shape does not
 * have the model. Adding those two numbers together would hide the distinction.
 *
 * ## The reversal operation
 *
 * Textbook graph edit distance has no operation for turning a link around, so `A --> B` drawn
 * as `B --> A` costs 2 there: one deletion and one insertion. This module adds an explicit
 * edge reversal primitive of cost 1, and reports it as one finding, because reversing a
 * relation is a single misunderstanding and a learner told "one link is missing and one link
 * is extra" has to work out for themselves that those are the same link. This is a deliberate
 * departure from the standard cost model and it is the reason `algorithm` names the model.
 */

import {
  SEP,
  isDirected,
  nodeLabel,
  nodeShape,
  parseKey,
  reversedKey,
  structuralKey,
  subgraphPath,
  undirectedFormOf,
} from './graph.js';
import { BLOCKED, hungarian } from './hungarian.js';

export class GraphTooLarge extends Error {
  constructor(size, limit) {
    super(
      `this graph has ${size} nodes and the node correspondence search is capped at ${limit}. ` +
        'Graph edit distance is NP-hard when the correspondence is unknown, so the cap is ' +
        'there instead of an unbounded run. Give the attempt the same node identifiers as ' +
        'the reference and the correspondence is known, which removes the search entirely.',
    );
    this.name = 'GraphTooLarge';
    this.size = size;
    this.limit = limit;
  }
}

export const LIMITS = {
  /** Above this, the exact correspondence search is not attempted. */
  exactNodes: 8,
  /** Above this, nothing is attempted and GraphTooLarge is thrown. */
  approxNodes: 64,
  /** Branch and bound gives up after this many node expansions and falls back to approx. */
  expansionBudget: 300000,
};

export const STRUCTURE_TYPES = new Set([
  'node-missing',
  'node-extra',
  'edge-missing',
  'edge-extra',
  'edge-reversed',
  'edge-direction',
]);
export const LABEL_TYPES = new Set(['node-label', 'edge-label']);
export const STYLE_TYPES = new Set(['node-shape', 'edge-style', 'edge-head']);
export const GROUPING_TYPES = new Set(['node-grouping']);

function bucketOf(type) {
  if (STRUCTURE_TYPES.has(type)) return 'structure';
  if (LABEL_TYPES.has(type)) return 'label';
  if (STYLE_TYPES.has(type)) return 'style';
  if (GROUPING_TYPES.has(type)) return 'grouping';
  throw new Error(`unclassified finding type: ${type}`);
}

/** Group a graph's edges by the structural key they take in the reference's namespace. */
function bucketEdges(graph, translate) {
  const buckets = new Map();
  for (const edge of graph.edges) {
    const from = translate(edge.from);
    const to = translate(edge.to);
    if (from === null || to === null) continue;
    const key = structuralKey(edge, translate);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(edge);
  }
  return buckets;
}

/** Edges that cannot even be placed, because one endpoint has no counterpart. */
function orphanEdges(graph, translate) {
  return graph.edges.filter(
    (edge) => translate(edge.from) === null || translate(edge.to) === null,
  );
}

function takeMatching(refEdges, attEdges) {
  // Pair equal labels first so that a two link bundle between the same pair does not report
  // both labels as wrong when only the pairing was arbitrary.
  const pairs = [];
  const remainingAtt = [...attEdges];
  const remainingRef = [];
  for (const refEdge of refEdges) {
    const exact = remainingAtt.findIndex((candidate) => candidate.label === refEdge.label);
    const index = exact >= 0 ? exact : remainingAtt.length ? 0 : -1;
    if (index < 0) {
      remainingRef.push(refEdge);
      continue;
    }
    pairs.push([refEdge, remainingAtt[index]]);
    remainingAtt.splice(index, 1);
  }
  return { pairs, remainingRef, remainingAtt };
}

function describeEdge(edge, label) {
  return {
    from: edge.from,
    to: edge.to,
    label: label === undefined ? edge.label : label,
    kind: edge.kind,
    head: edge.head,
    line: edge.line ?? null,
  };
}

/**
 * The whole comparison, for one fixed node correspondence.
 *
 * `mapping` is a Map from reference node id to attempt node id. Reference nodes absent from it
 * were deleted; attempt nodes that are not a value in it were inserted.
 */
export function diffUnderMapping(reference, attempt, mapping) {
  const findings = [];
  const inverse = new Map();
  for (const [refId, attId] of mapping) inverse.set(attId, refId);

  for (const [refId, refNode] of reference.nodes) {
    if (!mapping.has(refId)) {
      findings.push({ type: 'node-missing', id: refId, label: nodeLabel(refNode) });
    }
  }
  for (const [attId, attNode] of attempt.nodes) {
    if (!inverse.has(attId)) {
      findings.push({ type: 'node-extra', id: attId, label: nodeLabel(attNode) });
    }
  }

  for (const [refId, attId] of mapping) {
    const refNode = reference.nodes.get(refId);
    const attNode = attempt.nodes.get(attId);
    if (!refNode || !attNode) continue;
    if (nodeLabel(refNode) !== nodeLabel(attNode)) {
      findings.push({
        type: 'node-label',
        id: refId,
        expected: nodeLabel(refNode),
        actual: nodeLabel(attNode),
      });
    }
    if (nodeShape(refNode) !== nodeShape(attNode)) {
      findings.push({
        type: 'node-shape',
        id: refId,
        expected: nodeShape(refNode),
        actual: nodeShape(attNode),
      });
    }
    const refGroup = subgraphPath(reference, refNode).join(' / ');
    const attGroup = subgraphPath(attempt, attNode).join(' / ');
    if (refGroup !== attGroup) {
      findings.push({
        type: 'node-grouping',
        id: refId,
        expected: refGroup || null,
        actual: attGroup || null,
      });
    }
  }

  const identity = (id) => id;
  const toReference = (id) => (inverse.has(id) ? inverse.get(id) : null);

  const refBuckets = bucketEdges(reference, (id) => (mapping.has(id) ? id : null));
  const attBuckets = bucketEdges(attempt, toReference);

  for (const edge of orphanEdges(reference, (id) => (mapping.has(id) ? id : null))) {
    findings.push({ type: 'edge-missing', ...describeEdge(edge), reason: 'endpoint-missing' });
  }
  for (const edge of orphanEdges(attempt, toReference)) {
    findings.push({ type: 'edge-extra', ...describeEdge(edge), reason: 'endpoint-extra' });
  }

  const leftoverRef = new Map();
  const leftoverAtt = new Map(attBuckets);

  // Pass 1: same nodes, same direction. These are correct relations, and only their words and
  // decoration can be wrong.
  for (const [key, refEdges] of refBuckets) {
    const attEdges = leftoverAtt.get(key) || [];
    const { pairs, remainingRef, remainingAtt } = takeMatching(refEdges, attEdges);
    for (const [refEdge, attEdge] of pairs) {
      compareEdgeAttributes(refEdge, attEdge, findings, identity);
    }
    if (remainingAtt.length) leftoverAtt.set(key, remainingAtt);
    else leftoverAtt.delete(key);
    if (remainingRef.length) leftoverRef.set(key, remainingRef);
  }

  // Pass 2: reversals. A reference link survives to here only if the attempt had no link
  // between the same pair in the same direction, and the reversed attempt link survives only
  // if the reference had none in that direction either. Those two conditions together are what
  // makes this one mistake rather than two.
  for (const [key, refEdges] of [...leftoverRef]) {
    const { directed } = parseKey(key);
    if (!directed) continue;
    const mirror = reversedKey(key);
    const attEdges = leftoverAtt.get(mirror);
    if (!attEdges || attEdges.length === 0) continue;
    const { pairs, remainingRef, remainingAtt } = takeMatching(refEdges, attEdges);
    for (const [refEdge, attEdge] of pairs) {
      findings.push({
        type: 'edge-reversed',
        from: refEdge.from,
        to: refEdge.to,
        label: refEdge.label,
        drawnFrom: attEdge.from,
        drawnTo: attEdge.to,
      });
      compareEdgeAttributes(refEdge, attEdge, findings, identity);
    }
    if (remainingAtt.length) leftoverAtt.set(mirror, remainingAtt);
    else leftoverAtt.delete(mirror);
    if (remainingRef.length) leftoverRef.set(key, remainingRef);
    else leftoverRef.delete(key);
  }

  // Pass 3: right pair, wrong directedness. An arrow where the reference has a plain line, or
  // the other way round.
  for (const [key, refEdges] of [...leftoverRef]) {
    const partner = parseKey(key).directed
      ? undirectedFormOf(key)
      : null;
    const candidates = [];
    if (partner) {
      candidates.push(partner);
    } else {
      const { from, to } = parseKey(key);
      candidates.push(`directed${SEP}${from}${SEP}${to}`, `directed${SEP}${to}${SEP}${from}`);
    }
    for (const candidate of candidates) {
      const attEdges = leftoverAtt.get(candidate);
      if (!attEdges || attEdges.length === 0) continue;
      const refRemaining = leftoverRef.get(key) || [];
      if (refRemaining.length === 0) break;
      const { pairs, remainingRef, remainingAtt } = takeMatching(refRemaining, attEdges);
      for (const [refEdge, attEdge] of pairs) {
        findings.push({
          type: 'edge-direction',
          from: refEdge.from,
          to: refEdge.to,
          label: refEdge.label,
          expectedDirected: isDirected(refEdge),
          actualDirected: isDirected(attEdge),
        });
        compareEdgeAttributes(refEdge, attEdge, findings, identity, { skipHead: true });
      }
      if (remainingAtt.length) leftoverAtt.set(candidate, remainingAtt);
      else leftoverAtt.delete(candidate);
      if (remainingRef.length) leftoverRef.set(key, remainingRef);
      else leftoverRef.delete(key);
    }
  }

  for (const refEdges of leftoverRef.values()) {
    for (const edge of refEdges) {
      findings.push({ type: 'edge-missing', ...describeEdge(edge) });
    }
  }
  for (const attEdges of leftoverAtt.values()) {
    for (const edge of attEdges) {
      findings.push({ type: 'edge-extra', ...describeEdge(edge) });
    }
  }

  return findings;
}

function compareEdgeAttributes(refEdge, attEdge, findings, translate, options = {}) {
  if ((refEdge.label ?? null) !== (attEdge.label ?? null)) {
    findings.push({
      type: 'edge-label',
      from: refEdge.from,
      to: refEdge.to,
      expected: refEdge.label,
      actual: attEdge.label,
    });
  }
  if (refEdge.kind !== attEdge.kind) {
    findings.push({
      type: 'edge-style',
      from: refEdge.from,
      to: refEdge.to,
      expected: refEdge.kind,
      actual: attEdge.kind,
    });
  }
  if (!options.skipHead && refEdge.head !== attEdge.head) {
    findings.push({
      type: 'edge-head',
      from: refEdge.from,
      to: refEdge.to,
      expected: refEdge.head,
      actual: attEdge.head,
    });
  }
}

export function tallyFindings(findings) {
  const totals = { structure: 0, label: 0, style: 0, grouping: 0, total: 0 };
  for (const finding of findings) {
    totals[bucketOf(finding.type)] += 1;
    totals.total += 1;
  }
  return totals;
}

function identityMapping(reference, attempt) {
  const mapping = new Map();
  for (const id of reference.nodes.keys()) {
    if (attempt.nodes.has(id)) mapping.set(id, id);
  }
  return mapping;
}

/** True when every node the attempt uses is a node the reference already had. */
export function sharesNodeIdentifiers(reference, attempt) {
  for (const id of attempt.nodes.keys()) {
    if (!reference.nodes.has(id)) return false;
  }
  return true;
}

/**
 * Cost of the part of the correspondence that is already decided.
 *
 * Only reference nodes 0..depth-1 have been assigned. Edges are counted when both of their
 * endpoints are decided, so the value never decreases as depth grows, which is what makes it a
 * usable bound.
 */
function committedCost(reference, attempt, refIds, attIds, assign, depth) {
  const mapping = new Map();
  for (let i = 0; i < depth; i += 1) {
    if (assign[i] >= 0) mapping.set(refIds[i], attIds[assign[i]]);
  }
  const decidedRef = new Set(refIds.slice(0, depth));
  const decidedAtt = new Set();
  for (const attId of mapping.values()) decidedAtt.add(attId);

  const partialRef = restrictGraph(reference, decidedRef);
  const partialAtt = restrictGraph(attempt, decidedAtt);
  // The deletion of an undecided reference node is already counted here, because decidedRef
  // holds it while the mapping does not, which diffUnderMapping reports as node-missing.
  // Attempt nodes not yet chosen are left out of partialAtt entirely, since a later depth may
  // still match them, and counting them now would break the bound's admissibility.
  return tallyFindings(diffUnderMapping(partialRef, partialAtt, mapping)).total;
}

function restrictGraph(graph, keep) {
  return {
    direction: graph.direction,
    nodes: new Map([...graph.nodes].filter(([id]) => keep.has(id))),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
    subgraphs: graph.subgraphs,
  };
}

function exactSearch(reference, attempt, budget) {
  const refIds = [...reference.nodes.keys()];
  const attIds = [...attempt.nodes.keys()];
  const assign = new Array(refIds.length).fill(-1);
  let best = Infinity;
  let bestMapping = null;
  let expansions = 0;
  let exhausted = false;

  const used = new Array(attIds.length).fill(false);

  function recurse(depth) {
    if (exhausted) return;
    expansions += 1;
    if (expansions > budget) {
      exhausted = true;
      return;
    }
    const committed = committedCost(reference, attempt, refIds, attIds, assign, depth);
    if (committed >= best) return;
    if (depth === refIds.length) {
      const mapping = new Map();
      for (let i = 0; i < refIds.length; i += 1) {
        if (assign[i] >= 0) mapping.set(refIds[i], attIds[assign[i]]);
      }
      const cost = tallyFindings(diffUnderMapping(reference, attempt, mapping)).total;
      if (cost < best) {
        best = cost;
        bestMapping = mapping;
      }
      return;
    }
    for (let j = 0; j < attIds.length; j += 1) {
      if (used[j]) continue;
      used[j] = true;
      assign[depth] = j;
      recurse(depth + 1);
      used[j] = false;
      if (exhausted) return;
    }
    assign[depth] = -1;
    recurse(depth + 1);
  }

  recurse(0);
  return { mapping: bestMapping, exhausted, expansions };
}

/** Descriptors of the links touching one node, used by the bipartite approximation. */
function starOf(graph, id) {
  const descriptors = [];
  for (const edge of graph.edges) {
    if (edge.from === id) descriptors.push(isDirected(edge) ? 'out' : 'und');
    if (edge.to === id) descriptors.push(isDirected(edge) ? 'in' : 'und');
  }
  return descriptors.sort();
}

function multisetOverlap(left, right) {
  const counts = new Map();
  for (const item of left) counts.set(item, (counts.get(item) || 0) + 1);
  let overlap = 0;
  for (const item of right) {
    const available = counts.get(item) || 0;
    if (available > 0) {
      counts.set(item, available - 1);
      overlap += 1;
    }
  }
  return overlap;
}

function approximateMapping(reference, attempt) {
  const refIds = [...reference.nodes.keys()];
  const attIds = [...attempt.nodes.keys()];
  const n = refIds.length;
  const m = attIds.length;
  const size = n + m;
  const refStars = refIds.map((id) => starOf(reference, id));
  const attStars = attIds.map((id) => starOf(attempt, id));

  const cost = Array.from({ length: size }, () => new Array(size).fill(BLOCKED));
  for (let i = 0; i < n; i += 1) {
    const refNode = reference.nodes.get(refIds[i]);
    for (let j = 0; j < m; j += 1) {
      const attNode = attempt.nodes.get(attIds[j]);
      let value = 0;
      if (nodeLabel(refNode) !== nodeLabel(attNode)) value += 1;
      if (nodeShape(refNode) !== nodeShape(attNode)) value += 1;
      const overlap = multisetOverlap(refStars[i], attStars[j]);
      value += Math.max(refStars[i].length, attStars[j].length) - overlap;
      cost[i][j] = value;
    }
    cost[i][m + i] = 1 + refStars[i].length;
  }
  for (let j = 0; j < m; j += 1) {
    cost[n + j][j] = 1 + attStars[j].length;
    for (let i = 0; i < n; i += 1) cost[n + j][m + i] = 0;
  }
  for (let i = n; i < size; i += 1) {
    for (let j = m; j < size; j += 1) {
      if (cost[i][j] === BLOCKED) cost[i][j] = 0;
    }
  }

  const { assignment } = hungarian(cost);
  const mapping = new Map();
  for (let i = 0; i < n; i += 1) {
    const j = assignment[i];
    if (j < m) mapping.set(refIds[i], attIds[j]);
  }
  return mapping;
}

/**
 * Score an attempt against a reference.
 *
 * @param {object} reference parsed reference graph
 * @param {object} attempt parsed reconstruction
 * @param {object} [options]
 * @param {'auto'|'identity'|'exact'|'approx'} [options.mapping]
 */
export function score(reference, attempt, options = {}) {
  const requested = options.mapping || 'auto';
  const limits = { ...LIMITS, ...(options.limits || {}) };
  const size = Math.max(reference.nodes.size, attempt.nodes.size);

  let mode = requested;
  if (mode === 'auto') {
    mode = sharesNodeIdentifiers(reference, attempt) ? 'identity' : 'search';
  }

  if (mode === 'search') {
    if (size > limits.approxNodes) throw new GraphTooLarge(size, limits.approxNodes);
    mode = size <= limits.exactNodes ? 'exact' : 'approx';
  }
  if ((mode === 'exact' || mode === 'approx') && size > limits.approxNodes) {
    throw new GraphTooLarge(size, limits.approxNodes);
  }

  let mapping;
  let exact = true;
  let bound = 'exact';
  let algorithm;
  let complexity;
  let note = null;

  if (mode === 'identity') {
    mapping = identityMapping(reference, attempt);
    algorithm =
      'identity correspondence, unit cost edit distance with an explicit edge reversal ' +
      'primitive';
    complexity = 'O(V + E log E)';
    if (!sharesNodeIdentifiers(reference, attempt)) {
      note =
        'the identity correspondence was requested, and the attempt uses node identifiers ' +
        'the reference does not have. Those nodes count as insertions rather than being ' +
        'matched to anything.';
    }
  } else if (mode === 'exact') {
    if (size > limits.exactNodes) {
      throw new GraphTooLarge(size, limits.exactNodes);
    }
    const search = exactSearch(reference, attempt, limits.expansionBudget);
    if (search.exhausted || !search.mapping) {
      mapping = approximateMapping(reference, attempt);
      exact = false;
      bound = 'upper';
      algorithm =
        'bipartite assignment heuristic of Riesen and Bunke, solved with the Hungarian ' +
        'algorithm, after the exact search exhausted its budget';
      complexity = 'O(n^3)';
      note = `the exact branch and bound gave up after ${limits.expansionBudget} expansions.`;
    } else {
      mapping = search.mapping;
      algorithm =
        'exact branch and bound over node correspondences, unit cost edit distance with an ' +
        'explicit edge reversal primitive';
      complexity = `O(n! * E) worst case, ${search.expansions} expansions here`;
    }
  } else {
    mapping = approximateMapping(reference, attempt);
    exact = false;
    bound = 'upper';
    algorithm =
      'bipartite assignment heuristic of Riesen and Bunke, solved with the Hungarian algorithm';
    complexity = 'O(n^3)';
    note =
      `the graph has ${size} nodes, above the exact cap of ${limits.exactNodes}. The number ` +
      'reported is the cost of a real edit script, so it is an upper bound on the true ' +
      'distance and may be larger than it.';
  }

  const findings = diffUnderMapping(reference, attempt, mapping);
  const totals = tallyFindings(findings);
  const matchedAttempt = new Set(mapping.values());

  return {
    mode,
    exact,
    bound,
    algorithm,
    complexity,
    note,
    costModel: {
      unit: 1,
      buckets: ['structure', 'label', 'style', 'grouping'],
      reversalCost: 1,
      textbookReversalCost: 2,
    },
    mapping: {
      pairs: [...mapping].map(([refId, attId]) => [refId, attId]),
      unmatchedReference: [...reference.nodes.keys()].filter((id) => !mapping.has(id)),
      unmatchedAttempt: [...attempt.nodes.keys()].filter((id) => !matchedAttempt.has(id)),
    },
    totals,
    findings,
    perfect: totals.total === 0,
  };
}
