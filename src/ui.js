/**
 * The interactive drill.
 *
 * Two rules govern the interaction design.
 *
 * 1. Nothing requires a mouse. Dragging a node around the board is a convenience and it is
 *    never the only way to do anything. Every relation is placed through a form of three
 *    selects and a button, every placed relation can be reversed or removed from a button, and
 *    a focused node can be moved with the arrow keys. A page that cannot be used from the
 *    keyboard excludes people.
 *
 * 2. Where a node sits is not part of the answer. The board exists so the graph can be looked
 *    at. The scorer never sees a coordinate, and the page says so where the learner can read it.
 */

/* global document, window, FileReader, requestAnimationFrame */

// These imports are what makes this file a valid module on its own. The page build in
// `page.js` concatenates every module into one scope and strips the import lines, so in the
// published page these names are already in scope.
import { attemptFromPlacements, buildDrill } from './drill.js';
import { describeFinding, headlines } from './report.js';
import { score } from './score.js';
import { graphToJSON } from './graph.js';

const NODE_WIDTH = 132;
const NODE_HEIGHT = 52;

const state = {
  markdown: '',
  blockIndex: 0,
  drill: null,
  placements: [],
  nextPlacementId: 1,
  positions: new Map(),
  revealed: false,
  lastResult: null,
};

function $(id) {
  return document.getElementById(id);
}

function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function announce(message) {
  const live = $('live');
  live.textContent = '';
  // A live region only speaks when its text changes, and replacing identical text with itself
  // is not a change. The extra frame is what makes a repeated message announce twice.
  requestAnimationFrame(() => {
    live.textContent = message;
  });
}

/* ------------------------------------------------------------------ loading a document */

function loadMarkdown(markdown, { blockIndex = 0, sourceName = 'pasted text' } = {}) {
  state.markdown = markdown;
  state.blockIndex = blockIndex;
  state.placements = [];
  state.positions = new Map();
  state.revealed = false;
  state.lastResult = null;

  const problems = $('problems');
  clear(problems);
  problems.hidden = true;

  let drill;
  try {
    drill = buildDrill(markdown, { blockIndex, seed: 7 });
  } catch (error) {
    state.drill = null;
    problems.hidden = false;
    problems.appendChild(el('h3', { text: 'This diagram could not be read' }));
    problems.appendChild(
      el('p', {
        text:
          'The drill is not built, because scoring against a diagram this tool only partly ' +
          'understood would mark you down for a gap in the tool rather than a gap in your ' +
          'recall.',
      }),
    );
    problems.appendChild(el('pre', { text: error.message }));
    renderEverything();
    return;
  }

  state.drill = drill;
  layoutNodes(drill.pile.nodes);
  $('source-name').textContent = sourceName;
  const blockSelect = $('block-index');
  clear(blockSelect);
  for (let i = 0; i < drill.blockCount; i += 1) {
    blockSelect.appendChild(
      el('option', { value: String(i), text: `block ${i + 1} of ${drill.blockCount}` }),
    );
  }
  blockSelect.value = String(blockIndex);
  blockSelect.disabled = drill.blockCount < 2;

  renderDiagnostics(drill.diagnostics);
  renderEverything();
  announce(
    `Loaded ${sourceName}. ${drill.pile.nodes.length} nodes and ` +
      `${drill.pile.relations.length} relations to place.`,
  );
}

function renderDiagnostics(diagnostics) {
  const box = $('diagnostics');
  clear(box);
  const interesting = diagnostics.filter((item) => item.severity !== 'info');
  const info = diagnostics.filter((item) => item.severity === 'info');
  if (diagnostics.length === 0) {
    box.appendChild(
      el('p', { class: 'ok', text: 'Every line of the mermaid block was understood.' }),
    );
    return;
  }
  box.appendChild(
    el('p', {
      text:
        `${diagnostics.length} note${diagnostics.length === 1 ? '' : 's'} from the parser. ` +
        `${info.length} of them are directives that cannot change the graph.`,
    }),
  );
  const list = el('ul', { class: 'diagnostics' });
  for (const item of [...interesting, ...info]) {
    list.appendChild(
      el('li', { class: `sev-${item.severity}` }, [
        el('span', { class: 'sev', text: item.severity }),
        el('span', { text: ` line ${item.line}: ${item.message}` }),
      ]),
    );
  }
  box.appendChild(list);
}

/* ------------------------------------------------------------------------ board layout */

function layoutNodes(cards) {
  const count = cards.length || 1;
  const radiusX = Math.max(180, count * 34);
  const radiusY = Math.max(120, count * 22);
  cards.forEach((card, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    state.positions.set(card.id, {
      x: Math.round(radiusX + radiusX * 0.82 * Math.cos(angle)),
      y: Math.round(radiusY + radiusY * 0.82 * Math.sin(angle)),
    });
  });
}

function boardExtent() {
  let maxX = 320;
  let maxY = 240;
  for (const point of state.positions.values()) {
    maxX = Math.max(maxX, point.x + NODE_WIDTH);
    maxY = Math.max(maxY, point.y + NODE_HEIGHT);
  }
  return { width: maxX + 40, height: maxY + 40 };
}

function shapeElement(shape, x, y) {
  const w = NODE_WIDTH;
  const h = NODE_HEIGHT;
  const points = (list) => list.map(([px, py]) => `${x + px},${y + py}`).join(' ');
  switch (shape) {
    case 'diamond':
      return [svg('polygon', { points: points([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) })];
    case 'hexagon':
      return [
        svg('polygon', {
          points: points([[14, 0], [w - 14, 0], [w, h / 2], [w - 14, h], [14, h], [0, h / 2]]),
        }),
      ];
    case 'circle':
      return [svg('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 })];
    case 'double-circle':
      return [
        svg('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }),
        svg('ellipse', {
          cx: x + w / 2,
          cy: y + h / 2,
          rx: w / 2 - 5,
          ry: h / 2 - 5,
          class: 'inner',
        }),
      ];
    case 'stadium':
      return [svg('rect', { x, y, width: w, height: h, rx: h / 2, ry: h / 2 })];
    case 'round':
      return [svg('rect', { x, y, width: w, height: h, rx: 12, ry: 12 })];
    case 'cylinder':
      return [
        svg('rect', { x, y: y + 7, width: w, height: h - 14 }),
        svg('ellipse', { cx: x + w / 2, cy: y + 7, rx: w / 2, ry: 7, class: 'inner' }),
      ];
    case 'subroutine':
      return [
        svg('rect', { x, y, width: w, height: h }),
        svg('line', { x1: x + 8, y1: y, x2: x + 8, y2: y + h, class: 'inner' }),
        svg('line', { x1: x + w - 8, y1: y, x2: x + w - 8, y2: y + h, class: 'inner' }),
      ];
    case 'parallelogram':
    case 'parallelogram-alt':
      return [svg('polygon', { points: points([[16, 0], [w, 0], [w - 16, h], [0, h]]) })];
    case 'trapezoid':
    case 'trapezoid-alt':
      return [svg('polygon', { points: points([[18, 0], [w - 18, 0], [w, h], [0, h]]) })];
    case 'asymmetric':
      return [svg('polygon', { points: points([[0, 0], [w - 14, 0], [w, h / 2], [w - 14, h], [0, h]]) })];
    default:
      return [svg('rect', { x, y, width: w, height: h, rx: 3, ry: 3 })];
  }
}

function centreOf(id) {
  const point = state.positions.get(id) || { x: 0, y: 0 };
  return { x: point.x + NODE_WIDTH / 2, y: point.y + NODE_HEIGHT / 2 };
}

/** Where a line from `from` to `to` leaves the box around `from`. */
function boundaryPoint(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const halfW = NODE_WIDTH / 2 + 4;
  const halfH = NODE_HEIGHT / 2 + 4;
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function renderBoard() {
  const host = $('board');
  clear(host);
  if (!state.drill) {
    host.appendChild(el('p', { class: 'muted', text: 'No drill loaded.' }));
    return;
  }
  const { width, height } = boardExtent();
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label':
      'The board. Node positions are decoration and are not scored. The same information is ' +
      'in the list of placed relations below.',
    'data-testid': 'board-svg',
  });

  const defs = svg('defs');
  for (const [name, cls] of [['arrow', 'head-arrow'], ['circleend', 'head-circle'], ['crossend', 'head-cross']]) {
    const marker = svg('marker', {
      id: `marker-${name}`,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
      class: cls,
    });
    if (name === 'arrow') marker.appendChild(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z' }));
    if (name === 'circleend') marker.appendChild(svg('circle', { cx: 5, cy: 5, r: 4 }));
    if (name === 'crossend') {
      marker.appendChild(svg('path', { d: 'M 1 1 L 9 9 M 9 1 L 1 9' }));
    }
    defs.appendChild(marker);
  }
  root.appendChild(defs);

  const edgeLayer = svg('g', { class: 'edges' });
  const pairSeen = new Map();
  for (const placement of state.placements) {
    const key = [placement.from, placement.to].sort().join('|');
    const seen = pairSeen.get(key) || 0;
    pairSeen.set(key, seen + 1);
    const a = centreOf(placement.from);
    const b = centreOf(placement.to);
    const start = boundaryPoint(a, b);
    const end = boundaryPoint(b, a);
    const bow = seen * 26 * (placement.from < placement.to ? 1 : -1);
    const midX = (start.x + end.x) / 2 - (end.y - start.y) * (bow / 400);
    const midY = (start.y + end.y) / 2 + (end.x - start.x) * (bow / 400);
    const marker =
      placement.head === 'arrow'
        ? 'url(#marker-arrow)'
        : placement.head === 'circle'
          ? 'url(#marker-circleend)'
          : placement.head === 'cross'
            ? 'url(#marker-crossend)'
            : null;
    edgeLayer.appendChild(
      svg('path', {
        d: `M ${start.x} ${start.y} Q ${midX} ${midY} ${end.x} ${end.y}`,
        class: `edge kind-${placement.kind}`,
        'marker-end': marker,
        fill: 'none',
      }),
    );
    if (placement.label) {
      const text = svg('text', { x: midX, y: midY - 6, class: 'edge-label' });
      text.textContent = placement.label;
      edgeLayer.appendChild(text);
    }
  }
  root.appendChild(edgeLayer);

  for (const card of state.drill.pile.nodes) {
    const point = state.positions.get(card.id) || { x: 0, y: 0 };
    const group = svg('g', {
      class: 'node',
      tabindex: '0',
      role: 'button',
      'data-node': card.id,
      'aria-label':
        `${card.label}. Drag or use the arrow keys to move it. Moving it does not change ` +
        'your answer.',
    });
    for (const piece of shapeElement(card.shape, point.x, point.y)) group.appendChild(piece);
    const text = svg('text', {
      x: point.x + NODE_WIDTH / 2,
      y: point.y + NODE_HEIGHT / 2 + 4,
      'text-anchor': 'middle',
      class: 'node-label',
    });
    text.textContent = card.label.length > 18 ? `${card.label.slice(0, 17)}…` : card.label;
    group.appendChild(text);
    const title = svg('title');
    title.textContent = card.label;
    group.appendChild(title);
    attachNodeInteraction(group, card, root);
    root.appendChild(group);
  }

  host.appendChild(root);
}

function attachNodeInteraction(group, card, root) {
  group.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 24 : 8;
    const point = state.positions.get(card.id);
    const moves = {
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    };
    if (!moves[event.key]) return;
    event.preventDefault();
    state.positions.set(card.id, {
      x: Math.max(0, point.x + moves[event.key][0]),
      y: Math.max(0, point.y + moves[event.key][1]),
    });
    renderBoard();
    const moved = root.parentElement.querySelector(`[data-node="${card.id}"]`);
    if (moved) moved.focus();
  });

  group.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const svgRoot = root;
    const startPoint = state.positions.get(card.id);
    const rect = svgRoot.getBoundingClientRect();
    const scale = rect.width / svgRoot.viewBox.baseVal.width || 1;
    const originX = event.clientX;
    const originY = event.clientY;
    let moved = false;
    const move = (moveEvent) => {
      moved = true;
      state.positions.set(card.id, {
        x: Math.max(0, Math.round(startPoint.x + (moveEvent.clientX - originX) / scale)),
        y: Math.max(0, Math.round(startPoint.y + (moveEvent.clientY - originY) / scale)),
      });
      renderBoard();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) announce(`${card.label} moved. Positions are not scored.`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/* -------------------------------------------------------------------------- the pile */

function usedCardIds() {
  return new Set(state.placements.map((placement) => placement.cardId).filter(Boolean));
}

function describeCard(card) {
  const style = `${card.kind} ${card.head === 'open' ? 'line, no direction' : card.head}`;
  return card.label ? `"${card.label}" (${style})` : `unlabelled (${style})`;
}

function renderPile() {
  const host = $('pile');
  clear(host);
  if (!state.drill) return;
  const used = usedCardIds();
  const remaining = state.drill.pile.relations.filter((card) => !used.has(card.cardId));
  host.appendChild(
    el('p', {
      'data-testid': 'pile-count',
      text:
        `${remaining.length} of ${state.drill.pile.relations.length} relation cards still to ` +
        'place. Each card tells you the wording and the line style. Which two nodes it joins ' +
        'and which way it points are the parts you are recalling.',
    }),
  );
  const list = el('ul', { class: 'cards', 'data-testid': 'relation-cards' });
  for (const card of remaining) {
    list.appendChild(el('li', { class: 'card', text: describeCard(card) }));
  }
  if (remaining.length === 0) {
    list.appendChild(el('li', { class: 'card done', text: 'Every card has been placed.' }));
  }
  host.appendChild(list);
}

function renderPlacementForm() {
  const fromSelect = $('edge-from');
  const toSelect = $('edge-to');
  const cardSelect = $('edge-card');
  for (const select of [fromSelect, toSelect]) {
    const previous = select.value;
    clear(select);
    if (state.drill) {
      for (const card of [...state.drill.pile.nodes].sort((a, b) => a.label.localeCompare(b.label))) {
        select.appendChild(el('option', { value: card.id, text: card.label }));
      }
    }
    if (previous) select.value = previous;
  }
  const previousCard = cardSelect.value;
  clear(cardSelect);
  if (state.drill) {
    const used = usedCardIds();
    for (const card of state.drill.pile.relations) {
      if (used.has(card.cardId)) continue;
      cardSelect.appendChild(
        el('option', { value: card.cardId, text: describeCard(card) }),
      );
    }
    cardSelect.appendChild(
      el('option', { value: '', text: 'a relation that is not in the pile' }),
    );
  }
  if (previousCard) cardSelect.value = previousCard;
}

function renderPlacements() {
  const host = $('placements');
  clear(host);
  if (state.placements.length === 0) {
    host.appendChild(
      el('li', {
        class: 'muted',
        text: 'Nothing placed yet. This list is the answer that gets scored.',
      }),
    );
    return;
  }
  for (const placement of state.placements) {
    const fromLabel = labelFor(placement.from);
    const toLabel = labelFor(placement.to);
    const arrow = placement.head === 'open' ? '---' : '-->';
    const middle = placement.label ? ` ${arrow}|${placement.label}| ` : ` ${arrow} `;
    host.appendChild(
      el('li', { class: 'placement' }, [
        el('span', { class: 'relation', text: `${fromLabel}${middle}${toLabel}` }),
        el('span', { class: 'actions' }, [
          el('button', {
            type: 'button',
            class: 'small',
            'data-reverse': String(placement.id),
            text: 'Reverse',
            'aria-label': `Reverse the relation from ${fromLabel} to ${toLabel}`,
            onclick: () => reversePlacement(placement.id),
          }),
          el('button', {
            type: 'button',
            class: 'small',
            'data-remove': String(placement.id),
            text: 'Remove',
            'aria-label': `Remove the relation from ${fromLabel} to ${toLabel}`,
            onclick: () => removePlacement(placement.id),
          }),
        ]),
      ]),
    );
  }
}

function labelFor(id) {
  if (!state.drill) return id;
  const card = state.drill.pile.nodes.find((item) => item.id === id);
  return card ? card.label : id;
}

function addPlacement() {
  if (!state.drill) return;
  const from = $('edge-from').value;
  const to = $('edge-to').value;
  const cardId = $('edge-card').value;
  if (!from || !to) return;
  if (from === to) {
    announce('A relation needs two different nodes.');
    return;
  }
  const card = state.drill.pile.relations.find((item) => item.cardId === cardId);
  state.placements.push({
    id: state.nextPlacementId,
    cardId: card ? card.cardId : null,
    from,
    to,
    kind: card ? card.kind : 'solid',
    head: card ? card.head : 'arrow',
    label: card ? card.label : null,
  });
  state.nextPlacementId += 1;
  renderEverything();
  announce(`Placed ${labelFor(from)} to ${labelFor(to)}.`);
}

function reversePlacement(id) {
  const placement = state.placements.find((item) => item.id === id);
  if (!placement) return;
  [placement.from, placement.to] = [placement.to, placement.from];
  renderEverything();
  announce(`Reversed. It now runs ${labelFor(placement.from)} to ${labelFor(placement.to)}.`);
}

function removePlacement(id) {
  state.placements = state.placements.filter((item) => item.id !== id);
  renderEverything();
  announce('Removed.');
}

/* --------------------------------------------------------------------------- scoring */

function check() {
  if (!state.drill) return;
  const attempt = attemptFromPlacements(state.drill.pile, state.placements);
  let result;
  try {
    result = score(state.drill.reference, attempt);
  } catch (error) {
    $('result').hidden = false;
    clear($('result-body'));
    $('result-body').appendChild(el('p', { class: 'bad', text: error.message }));
    return;
  }
  state.lastResult = result;
  renderResult(result, attempt);
  announce(
    result.perfect
      ? 'Correct. Distance zero.'
      : `Distance ${result.totals.total}. ${result.totals.structure} structural, ` +
          `${result.totals.label} label.`,
  );
}

function renderResult(result, attempt) {
  const panel = $('result');
  const body = $('result-body');
  panel.hidden = false;
  clear(body);

  body.appendChild(
    el('p', { class: result.perfect ? 'verdict ok' : 'verdict', 'data-testid': 'verdict' }, [
      el('strong', {
        text: result.perfect
          ? 'Distance 0. Your reconstruction matches the reference exactly.'
          : `Graph edit distance ${result.totals.total}.`,
      }),
    ]),
  );

  const scoreboard = el('dl', { class: 'scoreboard', 'data-testid': 'scoreboard' });
  for (const [name, value, note] of [
    ['Structure', result.totals.structure, 'nodes, relations and which way they run'],
    ['Labels', result.totals.label, 'the words on a node or a relation'],
    ['Style', result.totals.style, 'shapes and line styles'],
    ['Grouping', result.totals.grouping, 'which subgraph a node sits in'],
  ]) {
    scoreboard.appendChild(el('dt', { text: name }));
    scoreboard.appendChild(
      el('dd', { 'data-bucket': name.toLowerCase() }, [
        el('span', { class: value === 0 ? 'num ok' : 'num', text: String(value) }),
        el('span', { class: 'note', text: note }),
      ]),
    );
  }
  body.appendChild(scoreboard);

  for (const line of headlines(result)) {
    body.appendChild(el('p', { class: 'headline', text: line }));
  }

  const reversals = result.findings.filter((finding) => finding.type === 'edge-reversed');
  if (reversals.length) {
    const box = el('div', { class: 'reversals', 'data-testid': 'reversals' });
    box.appendChild(
      el('h3', {
        text: reversals.length === 1 ? 'One relation is backwards' : `${reversals.length} relations are backwards`,
      }),
    );
    for (const finding of reversals) {
      box.appendChild(
        el('p', { text: describeFinding(finding, state.drill.reference, attempt) }),
      );
    }
    body.appendChild(box);
  }

  const others = result.findings.filter((finding) => finding.type !== 'edge-reversed');
  if (others.length) {
    const list = el('ul', { class: 'findings', 'data-testid': 'findings' });
    for (const finding of others) {
      list.appendChild(
        el('li', { text: describeFinding(finding, state.drill.reference, attempt) }),
      );
    }
    body.appendChild(el('h3', { text: 'Everything else' }));
    body.appendChild(list);
  }

  body.appendChild(
    el('details', { class: 'method' }, [
      el('summary', { text: 'How this number was computed' }),
      el('p', { text: `Algorithm: ${result.algorithm}.` }),
      el('p', { text: `Complexity: ${result.complexity}.` }),
      el('p', {
        text: result.exact
          ? 'This is an exact distance under the cost model, not an estimate.'
          : 'This is an UPPER BOUND. The method cannot prove it is the smallest edit script, ' +
            'so the true distance may be lower.',
      }),
      result.note ? el('p', { text: result.note }) : el('span', {}),
      el('p', {
        text:
          'Reversing a relation costs 1 here. Textbook graph edit distance has no reversal ' +
          'operation and charges 2 for the same mistake, one deletion and one insertion. ' +
          'Charging 1 and naming it is the whole point of this tool.',
      }),
      el('p', {
        text:
          'Node positions are not part of the comparison. A graph has no canonical layout, ' +
          'so the same graph arranged differently is the same graph.',
      }),
    ]),
  );
}

function revealReference() {
  const panel = $('reference');
  state.revealed = !state.revealed;
  panel.hidden = !state.revealed;
  $('reveal').textContent = state.revealed ? 'Hide the reference' : 'Show the reference';
  if (state.revealed && state.drill) {
    $('reference-source').textContent = state.drill.source;
  }
}

/* ---------------------------------------------------------------------------- render */

function renderEverything() {
  const hasDrill = Boolean(state.drill);
  $('drill').hidden = !hasDrill;
  if (hasDrill) {
    $('prose').textContent = state.drill.prose.trim();
  }
  renderPile();
  renderPlacementForm();
  renderPlacements();
  renderBoard();
  if (state.lastResult) {
    $('result').hidden = true;
    state.lastResult = null;
  }
}

/* ----------------------------------------------------------------------------- theme */

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  $('theme').value = theme;
}

/* ------------------------------------------------------------------------------ boot */

export function boot(samples) {
  $('theme').addEventListener('change', (event) => applyTheme(event.target.value));
  applyTheme('system');

  const sampleSelect = $('sample');
  for (const sample of samples) {
    sampleSelect.appendChild(el('option', { value: sample.name, text: sample.title }));
  }
  sampleSelect.addEventListener('change', () => {
    const sample = samples.find((item) => item.name === sampleSelect.value);
    if (sample) loadMarkdown(sample.markdown, { sourceName: sample.title });
  });

  $('block-index').addEventListener('change', (event) => {
    loadMarkdown(state.markdown, {
      blockIndex: Number(event.target.value),
      sourceName: $('source-name').textContent,
    });
  });

  $('add-edge').addEventListener('click', addPlacement);
  $('check').addEventListener('click', check);
  $('reveal').addEventListener('click', revealReference);
  $('reset').addEventListener('click', () => {
    state.placements = [];
    renderEverything();
    announce('Cleared. Nothing is placed.');
  });

  $('paste-load').addEventListener('click', () => {
    const text = $('paste').value;
    if (!text.trim()) {
      announce('The box is empty.');
      return;
    }
    loadMarkdown(text, { sourceName: 'pasted markdown' });
  });

  $('file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadMarkdown(String(reader.result), { sourceName: file.name });
    reader.readAsText(file);
  });

  loadMarkdown(samples[0].markdown, { sourceName: samples[0].title });

  // A deliberate, documented handle on the page's internals. The browser check drives the
  // real UI through it: it reads the reference, places every relation through the same form a
  // learner uses, and asserts that a correct reconstruction scores zero. Without a handle the
  // only end to end assertion available is that some numbers appeared, which a scorer that
  // always reports errors would also satisfy.
  window.diagramRecall = { state, score, buildDrill, attemptFromPlacements, graphToJSON };

  document.documentElement.setAttribute('data-ready', 'yes');
}
