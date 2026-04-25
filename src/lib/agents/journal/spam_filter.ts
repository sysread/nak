/**
 * Per-user Naive Bayes spam filter for the journal agent. Two
 * inputs feed it:
 *
 *   - Delete on an automatic entry trains the source thread's tokens
 *     as `spam`. The existing journal_thread_excludes row that the
 *     delete path writes already prevents the same thread from
 *     re-journaling, so spam training is naturally one-shot per
 *     thread; we just bolt the training call onto the delete path
 *     and let the thread-exclude do its existing job.
 *   - The ham button on an automatic entry trains as `ham`. The
 *     `journal_entries.ham_marked_at` column enforces one ham click
 *     per entry; the UI hides the button after the first click.
 *
 * The score is fed to the journal agent's prompt as a soft hint, NOT
 * a hard gate - the LLM keeps final say. A drastic mid-conversation
 * topic shift (technical thread that drifts into emotional territory,
 * say) should still be journaled even if the early tokens read as
 * "spam" to the classifier.
 *
 * Tokenization. Restricted to user + assistant messages (system and
 * tool messages carry plumbing, not user/assistant intent). Lowercased,
 * split on non-word boundaries, length-windowed to [2, 30] characters
 * (single chars are noise; very long "words" are usually URLs or
 * pasted hashes), then stemmed via Snowball English (Porter2). Stems
 * are not real words ("happiness" -> "happi", "studies" -> "studi")
 * but they're consistent, which is the only thing the classifier
 * needs. The same pipeline runs on both training and scoring; if it
 * ever drifts the model is dead because no token rows would join.
 *
 * English-only for v1. Snowball ships many languages but we hardcode
 * 'english' here - non-English tokens get stemmed by English rules,
 * which mostly leaves them alone but occasionally over-stems a
 * Spanish/Italian suffix. Acceptable for now; revisit if it matters.
 *
 * Naive Bayes. Top-15 most informative tokens (probabilities farthest
 * from 0.5 in either direction) combine in log-space to give a
 * posterior P(spam | observed tokens). Paul Graham's "A Plan for
 * Spam" approach (2002), which works well even with no stop-word
 * list: irrelevant tokens cluster near 0.5 and get filtered out by
 * the top-N selection.
 *
 * Cold start. The classifier returns coldStart=true (and no usable
 * score) until the user has at least SPAM_FILTER_COLD_START_MIN
 * examples of EACH class. Below that, the noise floor dominates the
 * posterior and a hint would mislead the LLM. The prompt path
 * suppresses the hint section entirely while coldStart holds.
 */

import { newStemmer } from 'snowball-stemmers';
import type { SupabaseService, Message } from '../../supabase';

// One stemmer instance per module load. Snowball stemmers are
// stateless across calls (the algorithm reads its input afresh each
// time), so we don't need to reinstantiate per tokenization.
const stemmer = newStemmer('english');

const MIN_TOKEN_LEN = 2;
const MAX_TOKEN_LEN = 30;

/**
 * Minimum count per class before the score is exposed to the LLM.
 * Below this threshold the posterior is noise. Hardcoded rather
 * than configurable: tuning it later requires data we don't have
 * yet, and a config knob would just defer the question.
 */
export const SPAM_FILTER_COLD_START_MIN = 20;

// Number of most-informative tokens to use in scoring. Graham's "A
// Plan for Spam" used 15; we follow suit. Increasing this dilutes
// the signal with near-0.5 tokens; decreasing it overfits to a
// handful of high-variance tokens.
const TOP_N_TOKENS = 15;

// Floor / ceiling on per-token probabilities to keep log() finite
// against true 0/1 edges that survive Laplace smoothing on degenerate
// data (e.g. the user's first ham example with a rare token).
const PROB_FLOOR = 0.01;
const PROB_CEIL = 0.99;

/**
 * Extract the deduped token set from a conversation. Filters out
 * system + tool messages, then lowercases, length-windows, and stems.
 * Returns unique tokens only (Naive Bayes counts presence per
 * conversation, not frequency, so duplicates would over-weight a
 * verbose conversation).
 */
export function tokenizeConversation(
  messages: readonly Pick<Message, 'role' | 'content'>[]
): string[] {
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (!msg.content) continue;
    for (const raw of msg.content.toLowerCase().split(/\W+/)) {
      if (raw.length < MIN_TOKEN_LEN || raw.length > MAX_TOKEN_LEN) continue;
      const stemmed = stemmer.stem(raw);
      if (stemmed.length < MIN_TOKEN_LEN) continue;
      seen.add(stemmed);
    }
  }
  return [...seen];
}

export interface SpamScore {
  /** P(spam | observed tokens) under Naive Bayes. */
  spamProbability: number;
  hamTotal: number;
  spamTotal: number;
  /** True when totals are below the cold-start threshold; the score is unreliable. */
  coldStart: boolean;
}

/**
 * Train the per-user model. Best-effort callers can swallow errors
 * since training is a side-effect on a feedback signal, not a
 * blocking step.
 */
export async function trainSpamFilter(
  supabase: SupabaseService,
  tokens: readonly string[],
  label: 'ham' | 'spam'
): Promise<void> {
  await supabase.trainJournalSpam(tokens, label);
}

/**
 * Score a token set against the user's model. Reads the totals first
 * to short-circuit the cold-start case without paying for the (often
 * sizable) token-row query.
 */
export async function scoreSpamFilter(
  supabase: SupabaseService,
  tokens: readonly string[]
): Promise<SpamScore> {
  const stats = await supabase.getJournalSpamStats();
  const coldStart =
    stats.hamTotal < SPAM_FILTER_COLD_START_MIN ||
    stats.spamTotal < SPAM_FILTER_COLD_START_MIN;
  if (coldStart) {
    return {
      spamProbability: 0.5,
      hamTotal: stats.hamTotal,
      spamTotal: stats.spamTotal,
      coldStart: true,
    };
  }
  if (tokens.length === 0) {
    // No tokens to score (filtered conversation was empty after
    // tokenization). Lean on the prior so the LLM sees the base
    // rate rather than a hardcoded 0.5.
    return {
      spamProbability:
        stats.spamTotal / Math.max(1, stats.hamTotal + stats.spamTotal),
      hamTotal: stats.hamTotal,
      spamTotal: stats.spamTotal,
      coldStart: false,
    };
  }
  const rows = await supabase.scoreJournalSpamTokens(tokens);
  return {
    spamProbability: computeNaiveBayes(rows, stats),
    hamTotal: stats.hamTotal,
    spamTotal: stats.spamTotal,
    coldStart: false,
  };
}

interface TokenRow {
  token: string;
  hamCount: number;
  spamCount: number;
}

/**
 * Naive Bayes posterior under Graham's top-N approach. For each
 * known token compute its individual P(spam|token) with Laplace
 * smoothing (add 1 to numerator, 2 to denominator) so a token
 * observed only in one class still has a defined probability.
 * Pick the TOP_N tokens whose probabilities are farthest from 0.5
 * in either direction (both very-spammy and very-hammy tokens carry
 * signal). Combine in log-space for numerical stability across long
 * conversations.
 */
function computeNaiveBayes(
  rows: readonly TokenRow[],
  stats: { hamTotal: number; spamTotal: number }
): number {
  if (rows.length === 0) {
    // No tokens matched the user's vocabulary. Lean on the prior.
    const total = stats.hamTotal + stats.spamTotal;
    return total > 0 ? stats.spamTotal / total : 0.5;
  }

  const probs: number[] = [];
  for (const row of rows) {
    const hamRate = (row.hamCount + 1) / (stats.hamTotal + 2);
    const spamRate = (row.spamCount + 1) / (stats.spamTotal + 2);
    const p = spamRate / (hamRate + spamRate);
    probs.push(Math.min(PROB_CEIL, Math.max(PROB_FLOOR, p)));
  }

  probs.sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5));
  const top = probs.slice(0, TOP_N_TOKENS);

  let logP = 0;
  let logQ = 0;
  for (const p of top) {
    logP += Math.log(p);
    logQ += Math.log(1 - p);
  }
  // Numerically stable: pull out the larger log to keep both
  // exponentials within range.
  const m = Math.max(logP, logQ);
  const num = Math.exp(logP - m);
  const den = num + Math.exp(logQ - m);
  return num / den;
}

/**
 * Convenience: fetch the thread's user/assistant messages, tokenize,
 * and train. Both delete paths (the journal_delete tool and the
 * Journal.svelte modal button) and the ham button call this so the
 * tokenization pipeline lives in one place.
 *
 * Best-effort. A failure here (network blip, missing thread, RPC
 * error) must not break the user-facing delete or ham action - the
 * classifier just doesn't learn from this one event. Errors get
 * swallowed silently rather than logged because they're routine
 * (the user might have cleared their session, the thread might
 * already be gone) and the alternative is noisy console spam on
 * every transient failure.
 */
export async function trainSpamFilterForThread(
  supabase: SupabaseService,
  threadId: string,
  label: 'ham' | 'spam'
): Promise<void> {
  try {
    const messages = await supabase.listMessages(threadId);
    const tokens = tokenizeConversation(messages);
    await trainSpamFilter(supabase, tokens, label);
  } catch {
    // Best-effort; see the docstring above for why this is silent.
  }
}

/**
 * Render the score as a natural-language hint for the journal prompt.
 * Returns null when cold-start - caller should suppress the section
 * rather than show "0% similar (50/50 prior)" which the LLM would
 * try to interpret. Score is expressed as "X% similar to spam" with
 * sample sizes inline so the model can reason about confidence
 * relative to how much training data exists.
 */
export function renderSpamHint(score: SpamScore): string | null {
  if (score.coldStart) return null;
  const pct = Math.round(score.spamProbability * 100);
  return (
    `Spam-filter hint (trained on ${score.hamTotal} ham + ${score.spamTotal} ` +
    `spam labeled conversations): this conversation's content is ${pct}% ` +
    `similar to ones the user previously marked not journal-worthy. Treat ` +
    `as a soft signal - your judgment of the conversation itself takes ` +
    `precedence.`
  );
}
