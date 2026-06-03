// ask_user (function-side port)
//
// Pure validator + sentinel return - the only tool whose "result"
// comes from the user, not from code. execute() validates the
// arguments and returns the pending sentinel object; the orchestrator
// (getStreamingResponse) recognises the sentinel by the
// __ask_user_pending__ flag, persists it verbatim as the tool-result
// row content, and emits END {terminalKind: 'suspended_for_ask_user'}.
// No DB contact from this tool itself - the persistence is the
// orchestrator's responsibility because suspend interlocks with the
// row's status transition.
//
// Wire schema lives in src/lib/tools/ask_user.schema.ts; the magic
// flag, the pending-content shape, and the answer-write helpers live
// in src/lib/tools/ask_user.ts on the browser side. On suspend the
// browser parses the persisted sentinel via parseAskUserContent and
// renders AskUserCard; on answer the browser UPDATEs the same tool
// row's content via buildAskUserAnswerContent and re-invokes the
// chat-loop with the post-answer history.

import { registerTool, type ToolDef } from '../performToolCall.ts';

// Mirror of src/lib/tools/ask_user.ts ASK_USER_PENDING_FLAG. Already
// duplicated in getStreamingResponse.ts for the orchestrator's
// suspend detection; same string, kept in lock-step in both places.
const ASK_USER_PENDING_FLAG = '__ask_user_pending__';

// Mirror of the limits in src/lib/tools/ask_user.schema.ts. The
// schema-side enforces these at request-build time too; we clamp
// here as belt-and-braces in case a malformed args string snuck
// past Venice's tools validation.
const ASK_USER_MIN_OPTIONS = 2;
const ASK_USER_MAX_OPTIONS = 5;
const ASK_USER_QUESTION_MAX_CHARS = 280;
const ASK_USER_LABEL_MAX_CHARS = 60;
const ASK_USER_DESCRIPTION_MAX_CHARS = 280;

interface AskUserOption {
  label: string;
  description: string;
}

interface AskUserPendingContent {
  [ASK_USER_PENDING_FLAG]: true;
  question: string;
  options: AskUserOption[];
}

function asNonEmptyString(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (trimmed.length === 0) return '';
  return trimmed.slice(0, max);
}

export const askUser: ToolDef = {
  name: 'ask_user',
  async execute(args: Record<string, unknown>) {
    const question = asNonEmptyString(args.question, ASK_USER_QUESTION_MAX_CHARS);
    if (!question) throw new Error('question is required (non-empty after trim)');

    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const options: AskUserOption[] = [];
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue;
      const obj = o as Record<string, unknown>;
      const label = asNonEmptyString(obj.label, ASK_USER_LABEL_MAX_CHARS);
      const description = asNonEmptyString(obj.description, ASK_USER_DESCRIPTION_MAX_CHARS);
      if (!label || !description) continue;
      options.push({ label, description });
    }
    if (options.length < ASK_USER_MIN_OPTIONS) {
      throw new Error(
        `at least ${ASK_USER_MIN_OPTIONS} options with non-empty label and description are required`,
      );
    }
    if (options.length > ASK_USER_MAX_OPTIONS) {
      options.length = ASK_USER_MAX_OPTIONS;
    }

    const pending: AskUserPendingContent = {
      [ASK_USER_PENDING_FLAG]: true,
      question,
      options,
    };
    return pending;
  },
};

registerTool(askUser);
