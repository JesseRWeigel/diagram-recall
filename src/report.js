/**
 * Turning a score into sentences a learner can act on.
 *
 * The rule this module follows: name the relation, not the edit. "One edge deleted and one
 * edge inserted" is arithmetic. "You got this relation backwards" is feedback.
 */

import { nodeLabel } from './graph.js';

const SHAPE_NAMES = {
  rect: 'rectangle',
  round: 'rounded rectangle',
  stadium: 'stadium',
  subroutine: 'subroutine box',
  cylinder: 'cylinder',
  circle: 'circle',
  'double-circle': 'double circle',
  asymmetric: 'flag',
  diamond: 'diamond',
  hexagon: 'hexagon',
  parallelogram: 'parallelogram',
  'parallelogram-alt': 'parallelogram',
  trapezoid: 'trapezoid',
  'trapezoid-alt': 'trapezoid',
};

const KIND_NAMES = { solid: 'solid', dotted: 'dotted', thick: 'thick' };
const HEAD_NAMES = { arrow: 'arrow', open: 'plain line', circle: 'circle end', cross: 'cross end' };

function caption(graph, id) {
  const node = graph.nodes.get(id);
  if (!node) return id;
  const text = nodeLabel(node);
  return text === id ? id : `${text} (${id})`;
}

/** One sentence per finding, in the reference's own vocabulary. */
export function describeFinding(finding, reference, attempt) {
  const ref = (id) => caption(reference, id);
  const att = (id) => caption(attempt, id);
  switch (finding.type) {
    case 'node-missing':
      return `The node ${ref(finding.id)} is not in your reconstruction.`;
    case 'node-extra':
      return `You added ${att(finding.id)}, which the reference does not have.`;
    case 'edge-reversed':
      return (
        `You got this relation backwards: the reference has ` +
        `${ref(finding.from)} --> ${ref(finding.to)}` +
        (finding.label ? ` labelled "${finding.label}"` : '') +
        `, and you drew ${ref(finding.to)} --> ${ref(finding.from)}. ` +
        'That is one mistake about which way the relation runs, not a missing link plus a ' +
        'spare one.'
      );
    case 'edge-direction':
      return finding.expectedDirected
        ? `${ref(finding.from)} and ${ref(finding.to)} are connected in both, but the ` +
            `reference points an arrow from ${ref(finding.from)} to ${ref(finding.to)} and ` +
            'you drew a plain line, which claims no direction.'
        : `${ref(finding.from)} and ${ref(finding.to)} are joined by a plain undirected ` +
            'line in the reference, and you drew a directed arrow.';
    case 'edge-missing':
      return (
        `The reference relates ${ref(finding.from)} to ${ref(finding.to)}` +
        (finding.label ? ` with the label "${finding.label}"` : '') +
        ', and your reconstruction has nothing between them' +
        (finding.reason === 'endpoint-missing'
          ? ', because one of the two nodes is missing.'
          : '.')
      );
    case 'edge-extra':
      return (
        `You related ${att(finding.from)} to ${att(finding.to)}` +
        (finding.label ? ` with the label "${finding.label}"` : '') +
        ', and the reference has no such relation' +
        (finding.reason === 'endpoint-extra' ? ', because one of the two nodes is extra.' : '.')
      );
    case 'node-label':
      return (
        `The node ${finding.id} should read "${finding.expected}" and yours reads ` +
        `"${finding.actual}". The shape of the diagram is unaffected.`
      );
    case 'edge-label':
      return (
        `The relation ${ref(finding.from)} --> ${ref(finding.to)} points the right way. Its ` +
        `label should be ${finding.expected === null ? 'blank' : `"${finding.expected}"`} and ` +
        `yours is ${finding.actual === null ? 'blank' : `"${finding.actual}"`}.`
      );
    case 'node-shape':
      return (
        `${ref(finding.id)} is drawn as a ${SHAPE_NAMES[finding.expected] || finding.expected} ` +
        `in the reference and as a ${SHAPE_NAMES[finding.actual] || finding.actual} in yours.`
      );
    case 'edge-style':
      return (
        `The relation ${ref(finding.from)} --> ${ref(finding.to)} is a ` +
        `${KIND_NAMES[finding.expected] || finding.expected} line in the reference and a ` +
        `${KIND_NAMES[finding.actual] || finding.actual} one in yours.`
      );
    case 'edge-head':
      return (
        `The relation ${ref(finding.from)} --> ${ref(finding.to)} ends in a ` +
        `${HEAD_NAMES[finding.expected] || finding.expected} in the reference and a ` +
        `${HEAD_NAMES[finding.actual] || finding.actual} in yours.`
      );
    case 'node-grouping':
      return (
        `${ref(finding.id)} belongs in ` +
        `${finding.expected ? `"${finding.expected}"` : 'no subgraph'} and you put it in ` +
        `${finding.actual ? `"${finding.actual}"` : 'no subgraph'}.`
      );
    default:
      throw new Error(`no wording for finding type ${finding.type}`);
  }
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The two headline sentences: how the shape did, and how the wording did. */
export function headlines(result) {
  const { totals, findings } = result;
  const reversals = findings.filter((finding) => finding.type === 'edge-reversed').length;
  const lines = [];

  if (totals.structure === 0) {
    lines.push('Structure: correct. Every node is present and every relation runs the way it does in the reference.');
  } else {
    const parts = [];
    if (reversals) parts.push(plural(reversals, 'reversed relation', 'reversed relations'));
    const missing = findings.filter((f) => f.type === 'edge-missing').length;
    const extra = findings.filter((f) => f.type === 'edge-extra').length;
    const nodeMissing = findings.filter((f) => f.type === 'node-missing').length;
    const nodeExtra = findings.filter((f) => f.type === 'node-extra').length;
    const direction = findings.filter((f) => f.type === 'edge-direction').length;
    if (missing) parts.push(plural(missing, 'missing relation', 'missing relations'));
    if (extra) parts.push(plural(extra, 'relation too many', 'relations too many'));
    if (nodeMissing) parts.push(plural(nodeMissing, 'missing node', 'missing nodes'));
    if (nodeExtra) parts.push(plural(nodeExtra, 'node too many', 'nodes too many'));
    if (direction) parts.push(plural(direction, 'directedness mismatch', 'directedness mismatches'));
    lines.push(
      `Structure: ${plural(totals.structure, 'edit', 'edits')} away (${parts.join(', ')}).`,
    );
  }

  if (totals.label === 0) {
    lines.push('Labels: correct.');
  } else {
    lines.push(
      `Labels: ${plural(totals.label, 'wording difference', 'wording differences')}. ` +
        'Wording is scored apart from structure, because a diagram with the right shape and ' +
        'one word wrong is a different result from one with the wrong shape.',
    );
  }

  if (totals.style) {
    lines.push(
      `Style: ${plural(totals.style, 'difference', 'differences')} in node shape or line ` +
        'style. These do not change what the diagram claims.',
    );
  }
  if (totals.grouping) {
    lines.push(`Grouping: ${plural(totals.grouping, 'node', 'nodes')} in the wrong subgraph.`);
  }
  return lines;
}

/** The full plain text report, as the CLI prints it. */
export function renderReport(result, reference, attempt) {
  const lines = [];
  lines.push(`algorithm  ${result.algorithm}`);
  lines.push(`complexity ${result.complexity}`);
  lines.push(
    `result     ${result.exact ? 'exact' : 'APPROXIMATE, upper bound'}` +
      (result.exact ? '' : ' (the true distance may be lower)'),
  );
  if (result.note) lines.push(`note       ${result.note}`);
  lines.push('');
  lines.push(
    'Node positions are not scored. A graph has no canonical layout, so arranging the right ' +
      'graph differently is not an error.',
  );
  lines.push('');
  if (result.perfect) {
    lines.push('Distance 0. The reconstruction matches the reference exactly.');
    return lines.join('\n');
  }
  for (const line of headlines(result)) lines.push(line);
  lines.push('');
  lines.push(
    `total distance ${result.totals.total} = ${result.totals.structure} structure + ` +
      `${result.totals.label} label + ${result.totals.style} style + ` +
      `${result.totals.grouping} grouping`,
  );
  lines.push('');
  const order = [
    'edge-reversed',
    'edge-direction',
    'edge-missing',
    'edge-extra',
    'node-missing',
    'node-extra',
    'edge-label',
    'node-label',
    'node-shape',
    'edge-style',
    'edge-head',
    'node-grouping',
  ];
  const sorted = [...result.findings].sort(
    (a, b) => order.indexOf(a.type) - order.indexOf(b.type),
  );
  for (const finding of sorted) {
    lines.push(`  - ${describeFinding(finding, reference, attempt)}`);
  }
  return lines.join('\n');
}
