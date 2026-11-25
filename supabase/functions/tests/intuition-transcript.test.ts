// Deno coverage for the perception transcript builder
// (venice/priming/intuition.ts buildTranscript). The pipeline body has
// no Venice fetch seam, so the exported builder gets direct coverage of
// the two behaviors the pregame depends on: role stripping (the
// perception must read only the conversation) and the head-trim window
// safety valve (a monster thread must lose old context, not 400 on the
// dense model's 256k window).
import { assertEquals } from 'jsr:@std/assert';
import {
  buildTranscript,
  PERCEPTION_TRANSCRIPT_MAX_CHARS,
} from '../venice/priming/intuition.ts';

Deno.test('buildTranscript: strips system and tool rows, renders both roles', () => {
  const out = buildTranscript([
    { role: 'system', content: 'PROMPT' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', content: 'result' },
    { role: 'assistant', content: '' }, // empty content carries no signal
  ]);
  assertEquals(out, 'user said: hi\n\nassistant said: hello');
});

Deno.test('buildTranscript: keeps the TAIL when the transcript overflows the window valve', () => {
  const big = 'x'.repeat(PERCEPTION_TRANSCRIPT_MAX_CHARS + 5_000);
  const out = buildTranscript([
    { role: 'user', content: 'OLD HEAD' },
    { role: 'assistant', content: big },
  ]);
  assertEquals(out.length, PERCEPTION_TRANSCRIPT_MAX_CHARS);
  // The head is gone...
  assertEquals(out.includes('OLD HEAD'), false);
  // ...the tail survived: the big turn's final chars + its role prefix
  // if it fit (it does not - the trim lands inside it).
  assertEquals(out.endsWith('x'), true);
});

Deno.test('buildTranscript: under the cap it is the exact join, untrimmed', () => {
  const out = buildTranscript([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ]);
  assertEquals(out, 'user said: a\n\nassistant said: b');
});
