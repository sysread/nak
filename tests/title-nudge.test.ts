// Guards on the title nudge in buildMetadataSystemMessage
// (src/lib/chat/prompt-assembly.ts).
//
// The regression these exist for: the topic-drift branch asked the
// model to rename the conversation without saying WHEN. A rename
// issued after the answer is written lands the tool call on the same
// assistant row as that answer, the loop feeds the tool result back,
// and the model writes its answer a second time - the user reads the
// same reply twice with minor wording drift. Both branches must carry
// the ordering instruction.

import { describe, expect, it } from 'vitest';
import { buildMetadataSystemMessage } from '../src/lib/chat/prompt-assembly';

type Opts = Parameters<typeof buildMetadataSystemMessage>[0];

const BASE: Opts = {
  enabledToolboxes: [],
  attachmentSummaries: [],
  currentTurnHasAttachments: false,
  threadTitle: 'New conversation',
  titleManuallySet: false,
  currentUserRound: 2,
};

function body(over: Partial<Opts>): string {
  const msg = buildMetadataSystemMessage({ ...BASE, ...over });
  return typeof msg.content === 'string' ? msg.content : '';
}

describe('title nudge ordering', () => {
  it('tells the model to rename before replying when the title has drifted', () => {
    const text = body({ threadTitle: 'Late Night Bread Bake' });
    expect(text).toContain('update_title');
    // The ordering, not just the ask. Without it the rename lands after
    // the answer and the answer gets written twice.
    expect(text).toMatch(/BEFORE replying/);
    expect(text).toMatch(/do not rename after you have\s+written your answer/);
  });

  it('tells the model to rename before replying on the placeholder title too', () => {
    const text = body({ threadTitle: 'New conversation' });
    expect(text).toContain('update_title');
    expect(text).toMatch(/[Bb]efore\s+replying/);
  });

  it('stays silent on round 1 - the auto-title worker owns naming there', () => {
    const text = body({ threadTitle: 'New conversation', currentUserRound: 1 });
    expect(text).not.toContain('update_title');
  });

  it('stays silent when the user named the thread themselves', () => {
    const text = body({ threadTitle: 'My Bread Notes', titleManuallySet: true });
    expect(text).not.toContain('update_title');
  });
});

describe('fork retitle nudge', () => {
  // A machine-built fork title: sigil + subscript-1 + base.
  const forkedTitle = '\u{1D523}\u{2081} Late Night Bread Bake';

  it('fires on a marked title, from round 1, even when manually-set was inherited', () => {
    const text = body({
      threadTitle: forkedTitle,
      titleManuallySet: true,
      currentUserRound: 1,
    });
    expect(text).toContain('This conversation is a fork');
    expect(text).toContain('update_title');
    // Names the parent by the base title (marker stripped).
    expect(text).toContain('"Late Night Bread Bake"');
    // The same double-write guard the regular nudges carry.
    expect(text).toMatch(/BEFORE replying/);
    // Conditional, not unconditional: rename only once the direction
    // is clear.
    expect(text).toMatch(/direction/);
  });

  it('replaces the drift nudge while the marker is present', () => {
    const text = body({ threadTitle: forkedTitle, currentUserRound: 3 });
    expect(text).toContain('This conversation is a fork');
    expect(text).not.toMatch(/topic\s+has meaningfully shifted/);
  });

  it('stays out of the way on unmarked titles', () => {
    const text = body({ threadTitle: 'Late Night Bread Bake' });
    expect(text).not.toContain('This conversation is a fork');
  });
});
