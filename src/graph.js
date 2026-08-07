/**
 * The graph model that the parser produces and the scorer consumes.
 *
 * Two decisions here shape everything downstream.
 *
 * 1. A graph has no coordinates. Nothing in this file, and nothing in `score.js`, can see
 *    where a node was placed on screen. A learner who arranges the right graph upside down
 *    has made no error, so there is nowhere for a layout to be recorded.
 *
 * 2. Direction is part of the structure, and decoration is not. `-->`, `--o` and `--x` are
 *    all directed links, so they share a structural key and differ only in `head`. `---` is
 *    an undirected link, so its structural key is order independent. Drawing an arrow where
 *    the reference has a plain line is therefore a structural error, while drawing `--x`
 *    where the reference has `-->` is a style error.
 */

// A separator that cannot occur in a mermaid node id. Written as an escape rather than as a
// literal control byte: a source file containing a NUL is classified as binary by git and grep,
// and a privacy scan then skips the whole file while reporting the same "clean" as a scan that
// read it.
export const SEP = '\u001f';

/** Line styles a link can be drawn in. */
export const EDGE_KINDS = ['solid', 'dotted', 'thick'];

/** Link endings. Everything except `open` is directed. */
export const EDGE_HEADS = ['arrow', 'open', 'circle', 'cross'];

export const DEFAULT_SHAPE = 'rect';

export function createGraph(direction = 'TD') {
  return {
    direction,
    nodes: new Map(),
    edges: [],
    subgraphs: new Map(),
  };
}

export function ensureNode(graph, id, line = null) {
  let node = graph.nodes.get(id);
  if (!node) {
    node = { id, label: null, shape: null, subgraph: null, line };
    graph.nodes.set(id, node);
  }
  return node;
}

/** A node with no bracketed caption displays its own id, so that is its label. */
export function nodeLabel(node) {
  return node.label === null ? node.id : node.label;
}

export function nodeShape(node) {
  return node.shape === null ? DEFAULT_SHAPE : node.shape;
}

export function isDirected(edge) {
  return edge.head !== 'open';
}

/**
 * The key two links must share to be "the same relation".
 *
 * `translate` maps a node id in this graph's namespace to the namespace the comparison happens
 * in. The scorer passes the inverse of its node correspondence so that an attempt drawn with
 * different node ids can still be compared edge for edge.
 */
export function structuralKey(edge, translate = (id) => id) {
  const from = translate(edge.from);
  const to = translate(edge.to);
  if (!isDirected(edge)) {
    const [a, b] = from <= to ? [from, to] : [to, from];
    return `undirected${SEP}${a}${SEP}${b}`;
  }
  return `directed${SEP}${from}${SEP}${to}`;
}

/** The key of the same relation drawn the other way round. Undirected keys are unchanged. */
export function reversedKey(key) {
  const [kind, a, b] = key.split(SEP);
  if (kind !== 'directed') return key;
  return `directed${SEP}${b}${SEP}${a}`;
}

export function undirectedFormOf(key) {
  const [, a, b] = key.split(SEP);
  const [x, y] = a <= b ? [a, b] : [b, a];
  return `undirected${SEP}${x}${SEP}${y}`;
}

export function parseKey(key) {
  const [kind, a, b] = key.split(SEP);
  return { directed: kind === 'directed', from: a, to: b };
}

/**
 * The chain of subgraph titles a node sits inside, outermost first. Grouping is compared as a
 * path so that moving a node from an inner subgraph to its parent is a single difference.
 */
export function subgraphPath(graph, node) {
  const path = [];
  let current = node.subgraph;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const group = graph.subgraphs.get(current);
    if (!group) break;
    path.unshift(group.title === null ? group.id : group.title);
    current = group.parent;
  }
  return path;
}

export function degreeOf(graph, id) {
  let degree = 0;
  for (const edge of graph.edges) {
    if (edge.from === id) degree += 1;
    if (edge.to === id) degree += 1;
  }
  return degree;
}

/** A stable, position free, JSON friendly form. Used by fixtures and by the CLI's --json. */
export function graphToJSON(graph) {
  return {
    direction: graph.direction,
    nodes: [...graph.nodes.values()]
      .map((node) => ({
        id: node.id,
        label: nodeLabel(node),
        shape: nodeShape(node),
        subgraph: subgraphPath(graph, node).join('/') || null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: graph.edges
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        head: edge.head,
        label: edge.label,
      }))
      .sort((a, b) => {
        const left = `${a.from}${SEP}${a.to}${SEP}${a.label ?? ''}${SEP}${a.head}`;
        const right = `${b.from}${SEP}${b.to}${SEP}${b.label ?? ''}${SEP}${b.head}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    subgraphs: [...graph.subgraphs.values()]
      .map((group) => ({
        id: group.id,
        title: group.title === null ? group.id : group.title,
        parent: group.parent,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** Rebuild a graph object from the JSON form, so a saved attempt can be scored. */
export function graphFromJSON(data) {
  const graph = createGraph(data.direction || 'TD');
  for (const group of data.subgraphs || []) {
    graph.subgraphs.set(group.id, {
      id: group.id,
      title: group.title ?? null,
      parent: group.parent ?? null,
    });
  }
  const groupByPath = new Map();
  for (const group of graph.subgraphs.values()) {
    const path = [];
    let current = group;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current.title === null ? current.id : current.title);
      current = current.parent ? graph.subgraphs.get(current.parent) : null;
    }
    groupByPath.set(path.join('/'), group.id);
  }
  for (const node of data.nodes || []) {
    const created = ensureNode(graph, node.id, node.line ?? null);
    created.label = node.label ?? null;
    created.shape = node.shape ?? null;
    created.subgraph = node.subgraph ? groupByPath.get(node.subgraph) ?? null : null;
  }
  for (const edge of data.edges || []) {
    ensureNode(graph, edge.from);
    ensureNode(graph, edge.to);
    graph.edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind || 'solid',
      head: edge.head || 'arrow',
      label: edge.label ?? null,
      line: edge.line ?? null,
    });
  }
  return graph;
}
