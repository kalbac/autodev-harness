import type { CorpusCase } from "./corpus-case.js";
import type { CorpusCaseResult, CorpusMetrics } from "./corpus-metrics.js";
import type { CaseExecutor } from "./corpus-runner.js";
import { evaluateCorpus } from "./corpus-runner.js";
import { renderCorpusReport } from "./corpus-report.js";

/** Parsed `eval` flags. Optional fields are ABSENT (never explicit `undefined`) so they
 *  compose under `exactOptionalPropertyTypes`. */
export interface EvalArgs {
  /** Corpus directory; the caller supplies the default when omitted. */
  corpus?: string;
  /** Commit-ish each case resets the target repo to; defaults to the repo's HEAD when
   *  omitted, captured ONCE before the first case so later cases' commits cannot drift
   *  the baseline out from under the corpus. */
  baseline?: string;
  /** Bound on each case's drain. */
  maxIterations: number;
  /** Write the rendered report here in addition to stdout. */
  out?: string;
  /** Directory the run's per-case artifacts and raw evidence are written to; the caller
   *  supplies the default when omitted. */
  artifacts?: string;
}

export const EVAL_USAGE =
  "usage: eval [--corpus <dir>] [--baseline <commit-ish>] [--max-iterations <n>] [--out <file>] [--artifacts <dir>]";

/** Default per-case drain bound. Generous enough for a multi-round task, finite so a
 *  pathological case cannot spin the corpus forever. */
export const DEFAULT_EVAL_MAX_ITERATIONS = 20;

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Parse the args after the `eval` verb. Mirrors the `--port` / `--max-iterations` style
 * already used by the other verbs: a flag with a missing value is a LOUD usage error,
 * never a silently-dropped option, and an unknown argument is rejected rather than
 * ignored (a typo'd `--corpuss` must not quietly run the default corpus).
 */
export function parseEvalArgs(argv: string[]): EvalArgs {
  let corpus: string | undefined;
  let baseline: string | undefined;
  let out: string | undefined;
  let artifacts: string | undefined;
  let maxIterations = DEFAULT_EVAL_MAX_ITERATIONS;

  const take = (flag: string, i: number): string => {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("-")) {
      throw new Error(`${flag}: missing value (${EVAL_USAGE})`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--corpus") {
      corpus = take(arg, i);
      i++;
    } else if (arg.startsWith("--corpus=")) {
      corpus = arg.slice("--corpus=".length);
    } else if (arg === "--baseline") {
      baseline = take(arg, i);
      i++;
    } else if (arg.startsWith("--baseline=")) {
      baseline = arg.slice("--baseline=".length);
    } else if (arg === "--out") {
      out = take(arg, i);
      i++;
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg === "--artifacts") {
      artifacts = take(arg, i);
      i++;
    } else if (arg.startsWith("--artifacts=")) {
      artifacts = arg.slice("--artifacts=".length);
    } else if (arg === "--max-iterations") {
      maxIterations = parsePositiveInt(take(arg, i), arg);
      i++;
    } else if (arg.startsWith("--max-iterations=")) {
      maxIterations = parsePositiveInt(arg.slice("--max-iterations=".length), "--max-iterations");
    } else {
      throw new Error(`eval: unexpected argument ${JSON.stringify(arg)} (${EVAL_USAGE})`);
    }
  }

  // An empty string would silently resolve to the current directory / an unnamed file,
  // which is worse than a refusal.
  for (const [flag, value] of [
    ["--corpus", corpus],
    ["--baseline", baseline],
    ["--out", out],
    ["--artifacts", artifacts],
  ] as const) {
    if (value !== undefined && value.trim() === "") {
      throw new Error(`${flag}: value must not be empty (${EVAL_USAGE})`);
    }
  }

  return {
    ...(corpus !== undefined ? { corpus } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    maxIterations,
  };
}

/** Whether a corpus run met the pass bar, and why not when it did not. */
export interface PassBar {
  met: boolean;
  reasons: string[];
}

/**
 * The corpus pass bar. Two conditions, both required:
 *
 *  1. **Every case's actual outcome matched its expectation.** A corpus is a set of
 *     assertions about the harness; one broken assertion is a failed measurement.
 *  2. **The escaped-defect rate is exactly 0, and it was actually MEASURED.** This is
 *     the headline: an adversarial case that commits is a defect the gate let through,
 *     which is the one failure the whole project exists to prevent.
 *
 * Condition 2 is not redundant with 1 even though a failing case already fails the bar
 * — it is stated separately because it is the number the harness is judged on, and
 * because a `null` rate (no adversarial case ran) must NOT read as a pass. A corpus of
 * nothing but good cases proves the harness can commit work; it proves nothing about
 * its catching power, and "not measured" reading as "perfect" is precisely the
 * fail-open this codebase keeps closing (Principle 10).
 */
export function evaluatePassBar(m: CorpusMetrics): PassBar {
  const reasons: string[] = [];
  if (m.total === 0) reasons.push("the corpus is empty -- nothing was measured");
  if (m.failed > 0) {
    reasons.push(`${m.failed}/${m.total} case(s) did not match their expected outcome`);
  }
  if (m.escaped_defect_rate === null) {
    reasons.push("escaped-defect rate was not measured -- the corpus has no adversarial case");
  } else if (m.escaped_defect_rate > 0) {
    reasons.push(`escaped-defect rate is ${Math.round(m.escaped_defect_rate * 1000) / 10}% (must be 0%)`);
  }
  return { met: reasons.length === 0, reasons };
}

export interface EvalRunResult {
  metrics: CorpusMetrics;
  markdown: string;
  passBar: PassBar;
  /** Every executed case with its raw evidence — what the run manifest is built from. */
  results: CorpusCaseResult[];
}

export interface EvalHooks {
  /**
   * Called after every case with ALL results so far, so the caller can persist partial
   * diagnostics. A corpus run is minutes per case; a run that dies on case 6 must not
   * take the diagnostics of cases 1-5 with it.
   *
   * CALLER CONTRACT: must not throw (it is awaited inside the run — see
   * `CorpusRunHooks`). A caller doing IO here swallows its own failures.
   */
  onProgress?: (results: CorpusCaseResult[]) => Promise<void>;
}

/**
 * Drive a corpus end to end and render it: run every case through the executor, fold the
 * results into metrics, render the Corpus Report, and judge the pass bar. Narrates each
 * case as it starts and finishes, because a real corpus run takes minutes per case and
 * is meant to be watched by the operator — a silent process for that long is
 * indistinguishable from a hung one.
 */
export async function runEval(
  cases: CorpusCase[],
  executor: CaseExecutor,
  print: (line: string) => void,
  hooks: EvalHooks = {},
): Promise<EvalRunResult> {
  const seen: CorpusCaseResult[] = [];
  const { metrics, results } = await evaluateCorpus(cases, executor, {
    onCaseStart: (c, i, total) => print(`[${i + 1}/${total}] ${c.id} (${c.type}${c.adversarial ? ", adversarial" : ""})`),
    onCaseDone: async (r, i, total) => {
      const outcome = r.evidence === null ? "errored (no evidence)" : r.evidence.outcome;
      print(`[${i + 1}/${total}] ${r.case.id} -> ${outcome} (expected ${r.case.expected.outcome})`);
      // An errored case's reason is printed HERE, at the case, rather than only landing in
      // the manifest: the operator is watching a run that takes minutes per case, and
      // "errored (no evidence)" with the cause withheld is the exact experience #126 exists
      // to end.
      if (r.error !== undefined) print(`      ${r.error}`);
      seen.push(r);
      await hooks.onProgress?.(seen);
    },
  });

  return { metrics, results, markdown: renderCorpusReport(metrics), passBar: evaluatePassBar(metrics) };
}
