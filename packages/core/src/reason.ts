/**
 * The one line under the phrase that says why. It is built from the signals,
 * not by Jev, so it is deterministic and every part of it is true of the pull
 * request even when Jev's verdict differs from the local rule.
 */
import type { CiState, PrSignals, Verdict } from './types.js';

const SEPARATOR = ' · ';
const MAX_PARTS = 3;

const CI_LABELS: Record<CiState, string> = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI pending',
  none: 'no CI',
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** `docs only` replaces the line count, because size does not matter for a docs-only pull request. */
function sizeLabel(signals: PrSignals): string {
  return signals.docsOnly ? 'docs only' : plural(signals.linesChanged, 'line');
}

export function reasonFor(signals: PrSignals, verdict: Verdict): string {
  const size = sizeLabel(signals);
  const ci = CI_LABELS[signals.ci];
  const parts: string[] = [];

  if (verdict === 'no') {
    // The causes of a no, most decisive first.
    if (signals.ci === 'failing') parts.push(ci);
    if (signals.isDraft) parts.push('draft');
    if (signals.changesRequested > 0) parts.push('changes requested');
    // The size is a cause when it is over the limit, and context otherwise.
    // Good news about CI only appears when nothing else explains the no,
    // which also covers a no from Jev that the local rule would not give.
    const blocked = parts.length > 0;
    parts.push(size);
    if (!blocked) parts.push(ci);
  } else if (verdict === 'unclear') {
    // CI leads when it is what stands in the way. Otherwise the size does.
    if (signals.ci === 'passing') parts.push(size, ci);
    else parts.push(ci, size);
  } else {
    parts.push(size, ci);
    if (signals.approvals > 0) parts.push(plural(signals.approvals, 'approval'));
  }

  return parts.slice(0, MAX_PARTS).join(SEPARATOR);
}
