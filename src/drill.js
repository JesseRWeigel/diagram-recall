/**
 * Turning a markdown explanation into a retrieval practice drill.
 *
 * The learner reads the prose with the diagram removed, then rebuilds the diagram from a pile
 * of pieces. The pile deliberately withholds exactly the thing being practised:
 *
 *   node cards      carry the caption and the shape, because remembering that a box was a
 *                   diamond is not the skill under test.
 *   relation cards  carry the label and the line style, and NOT the two endpoints and NOT the
 *                   direction. Placing each relation and choosing which way it runs is the
 *                   whole exercise.
 *
 * The shuffle is seeded so that a drill is reproducible, which is what lets a fixture assert
 * on one.
 */

import { createGraph, ensureNode, nodeLabel, nodeShape, subgraphPath } from './graph.js';
import { ERROR, extractMermaidBlocks, parseMarkdown } from './mermaid.js';

/** mulberry32. Small, fast, and identical in every JavaScript engine. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Replace the chosen mermaid block with a placeholder so the prose can be shown on its own. */
export function proseWithout(markdown, blockIndex) {
  const blocks = extractMermaidBlocks(markdown);
  if (blockIndex < 0 || blockIndex >= blocks.length) return markdown;
  const block = blocks[blockIndex];
  const lines = markdown.split(/\r\n|\r|\n/);
  const first = block.fenceLine - 1;
  let last = first;
  while (last < lines.length) {
    if (last > first && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines[last])) break;
    last += 1;
  }
  const kept = [
    ...lines.slice(0, first),
    '> The diagram that was here is what you are about to rebuild.',
    ...lines.slice(Math.min(last + 1, lines.length)),
  ];
  return kept.join('\n');
}

export class DrillError extends Error {}

/**
 * @param {string} markdown any markdown document containing a fenced ```mermaid block
 * @param {object} [options]
 * @param {number} [options.blockIndex] which block, when the file has several
 * @param {number} [options.seed] shuffle seed
 * @param {boolean} [options.allowErrors] build anyway despite error diagnostics
 */
export function buildDrill(markdown, options = {}) {
  const blockIndex = options.blockIndex ?? 0;
  const seed = options.seed ?? 1;
  const parsed = parseMarkdown(markdown, { blockIndex });
  const errors = parsed.diagnostics.filter((item) => item.severity === ERROR);
  if (errors.length && !options.allowErrors) {
    throw new DrillError(
      'refusing to build a drill from a diagram this parser could not fully read. Scoring a ' +
        'learner against an incomplete reference marks them down for a gap in this tool. ' +
        'The unreadable lines are:\n' +
        errors.map((item) => `  line ${item.line}: ${item.text}\n    ${item.message}`).join('\n'),
    );
  }

  const random = seededRandom(seed);
  const reference = parsed.graph;

  const nodeCards = [...reference.nodes.values()].map((node) => ({
    id: node.id,
    label: nodeLabel(node),
    shape: nodeShape(node),
    subgraph: subgraphPath(reference, node).join(' / ') || null,
  }));

  const relationCards = reference.edges.map((edge, index) => ({
    cardId: `r${index + 1}`,
    label: edge.label,
    kind: edge.kind,
    head: edge.head,
    directed: edge.head !== 'open',
  }));

  const subgraphs = [...reference.subgraphs.values()].map((group) => ({
    id: group.id,
    title: group.title === null ? group.id : group.title,
  }));

  return {
    blockIndex,
    seed,
    prose: proseWithout(markdown, blockIndex),
    source: parsed.block ? parsed.block.code : '',
    reference,
    diagnostics: parsed.diagnostics,
    blockCount: parsed.blocks.length,
    pile: {
      nodes: shuffle(nodeCards, random),
      relations: shuffle(relationCards, random),
      subgraphs,
    },
  };
}

/**
 * Build an attempt graph from what the page collected: the node cards the learner kept, and
 * the placements they made. Positions are accepted and thrown away, since nothing scores them.
 *
 * `options.include` narrows the pile to the node cards the learner actually used. Left out,
 * every card counts as placed, which is the page's default because every card starts on the
 * board.
 */
export function attemptFromPlacements(pile, placements, options = {}) {
  const graph = createGraph('TD');
  const include = options.include ? new Set(options.include) : null;
  const byTitle = new Map();
  for (const group of pile.subgraphs || []) {
    graph.subgraphs.set(group.id, { id: group.id, title: group.title, parent: null });
    byTitle.set(group.title, group.id);
  }
  for (const card of pile.nodes) {
    if (include && !include.has(card.id)) continue;
    const node = ensureNode(graph, card.id);
    node.label = card.label;
    node.shape = card.shape;
    node.subgraph = card.subgraph ? byTitle.get(card.subgraph) ?? null : null;
  }
  for (const placement of placements) {
    if (!graph.nodes.has(placement.from) || !graph.nodes.has(placement.to)) {
      throw new DrillError(
        `placement refers to "${placement.from}" or "${placement.to}", which is not a node ` +
          'card in this drill.',
      );
    }
    graph.edges.push({
      from: placement.from,
      to: placement.to,
      kind: placement.kind || 'solid',
      head: placement.head || 'arrow',
      label: placement.label ?? null,
      line: null,
    });
  }
  return graph;
}
