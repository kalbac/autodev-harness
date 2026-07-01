# Donor Extraction Brief: Aider

> Source: `D:/Projects/autodev-harness/references/aider/` (cloned copy). All paths below are
> relative to that root. Target: **autodev-harness** — Node LTS + TypeScript headless daemon
> + local web UI, file-based blackboard state, worker = `claude -p` CLI, critic = `codex exec`
> GPT-5.5, base architecture derived from a PowerShell autodev-loop prototype.
>
> Axes referenced throughout: **STATE**, **WORKER-BACKEND**, **CHECKPOINT**, **ISOLATION**,
> **GATE**, **MODEL-ROUTING**.

---

## 1. License

`LICENSE.txt:1-9` confirms **Apache License, Version 2.0**. This is also declared in
`pyproject.toml:10` (`"License :: OSI Approved :: Apache Software License"`). No `NOTICE` file
exists in the repo root (`ls NOTICE*` → not found), and `LICENSE.txt` ends with the generic
Apache boilerplate appendix (`LICENSE.txt:172-202`) rather than a filled-in copyright line —
Aider's actual copyright attribution lives in its git history / `README.md`, not in the license
file itself.

**What Apache-2.0 actually permits/requires** (per `LICENSE.txt` sections 2, 3, 4, 6):
- **Verbatim or modified code reuse is allowed**, including in a closed-source/private project
  (Section 2, grant of copyright license; Section 3, grant of patent license).
- Section 4 requires that any **redistribution** of the Work or Derivative Works: (a) include a
  copy of the License, (b) mark modified files with prominent notices, (c) retain existing
  copyright/patent/trademark notices from the Source form, and (d) if a `NOTICE` file exists
  upstream, reproduce its attribution notices in redistributed copies. Aider has no `NOTICE`
  file today, so (d) is currently moot, but if one appears upstream later we would need to carry
  it forward.
- Section 6 forbids using Aider's trademarks/names except for describing origin.
- **Implication for autodev-harness** (currently unlicensed/private repo): we **can** copy Aider
  source files or substantial code verbatim (e.g. port `repomap.py` logic, or a coder's
  regex/parsing routines) into our TypeScript codebase, **provided** we (1) keep a copy of the
  Apache-2.0 license text somewhere in the repo (e.g. `THIRD_PARTY_LICENSES/aider-LICENSE.txt`),
  (2) note in the ported file/header that it is derived from Aider (Apache-2.0), and (3) don't
  imply endorsement by the Aider project. Since we're porting Python → TypeScript, most "steals"
  will be **architecture/algorithm ports** (re-implemented, not copy-pasted), which sidesteps
  Section 4(a)-(c) entirely — but if we ever lift a literal regex, prompt string, or query file
  (e.g. the `.scm` tree-sitter queries verbatim), the marking/attribution obligations kick in.
- No copyleft — Apache-2.0 is permissive, does not require autodev-harness itself to be open
  sourced.

---

## 2. Repo-map mechanism (tree-sitter + PageRank context selection)

Core file: `aider/repomap.py` (867 lines). Class `RepoMap` at `aider/repomap.py:42`.

### Parsing (tree-sitter queries)
- Query files live under `aider/queries/tree-sitter-language-pack/*-tags.scm` (confirmed via
  `Glob`, e.g. `aider/queries/tree-sitter-language-pack/javascript-tags.scm`,
  `go-tags.scm`, `python` equivalents, one `.scm` per language) — these are standard
  tree-sitter tag queries (defs/refs), not Aider-invented syntax.
- `RepoMap.get_tags_raw(fname, rel_fname)` at `aider/repomap.py:279-363`: resolves the
  language via `filename_to_lang`, loads the `.scm` query for that language
  (`get_scm_fname(lang)`, `repomap.py:291-294`), parses the file into a tree-sitter AST
  (`repomap.py:299`), and runs the query via `Query(language, query_scm)` + a cursor
  (`_run_captures`, `repomap.py:266-277`, handling both old/new tree-sitter Python binding
  APIs). Captures tagged `name.definition.*` become `kind="def"` Tags, `name.reference.*`
  become `kind="ref"` Tags (`repomap.py:318-336`).
- **Fallback for def-only languages** (e.g. C/C++ where the query only yields defs, no refs):
  falls back to Pygments lexing to backfill reference tokens (`repomap.py:338-363`).
- Results are cached per-file keyed by mtime in a `diskcache.Cache` (SQLite-backed) at
  `RepoMap.get_tags` (`repomap.py:233-264`), with graceful fallback to an in-memory dict on
  SQLite errors (`tags_cache_error`, `repomap.py:177-215`).

### Ranking (PageRank via networkx)
- `RepoMap.get_ranked_tags(chat_fnames, other_fnames, mentioned_fnames, mentioned_idents,
  progress=None)` at `aider/repomap.py:365-574`. Imports `networkx` locally
  (`repomap.py:368`).
- Builds a `MultiDiGraph` where nodes are files and edges represent "file A references an
  identifier defined in file B", weighted by heuristics (`repomap.py:470-514`):
  - Files currently open in the chat get a **50x** edge-weight multiplier
    (`use_mul *= 50`, `repomap.py:509`).
  - Identifiers explicitly mentioned by the user get a **10x** multiplier
    (`repomap.py:492-493`).
  - "Interesting" identifiers (snake_case/kebab-case/camelCase, length ≥ 8) get **10x**
    (`repomap.py:494-495`); private-looking (`_`-prefixed) get **0.1x**
    (`repomap.py:496-497`); identifiers defined in >5 places get **0.1x** (de-dupe common
    names) (`repomap.py:498-499`).
  - `personalization` vector seeds PageRank toward chat files / mentioned files/idents
    (`repomap.py:374, 422-445`), i.e. a **personalized PageRank**, not vanilla PageRank.
  - Runs `nx.pagerank(G, weight="weight", **pers_args)` (`repomap.py:525`), with a
    `ZeroDivisionError` fallback to unpersonalized PageRank, then to an empty result
    (`repomap.py:526-531`).
  - Rank mass is redistributed from each node across its out-edges to individual
    `(file, identifier)` definitions (`repomap.py:533-545`), then sorted descending
    (`repomap.py:547-550`) to produce the final `ranked_tags` list.

### Token-budget fitting (binary search)
- `RepoMap.get_ranked_tags_map_uncached` at `aider/repomap.py:629-706` runs a **binary search**
  over how many top-ranked tags to include, converting candidate tag-lists to a rendered tree
  (`self.to_tree`, `repomap.py:686`) and counting tokens (`self.token_count`, `repomap.py:687`).
  It accepts a tree once token count is within **15% of the target** (`pct_err < ok_err`,
  `repomap.py:689-696`) or keeps the best-so-far under budget. `middle` starts at
  `max_map_tokens // 25` (`repomap.py:676`) as a rough tags-per-token estimate.
- `RepoMap.token_count` (`repomap.py:89-101`) uses **sampling** for large texts (every Nth line,
  ~100 samples) to estimate tokens cheaply rather than tokenizing the full text every binary-
  search iteration — a real perf trick worth stealing conceptually if we ever build our own
  token-budgeted context assembler.
- **Map size scaling**: `get_repo_map` gives a *bigger* map budget when no files are yet in the
  chat (`repomap.py:120-132`, scaled by `map_mul_no_files` and capped against
  `max_context_window`), padded by 4096 tokens (`repomap.py:123`).
- Entry point `RepoMap.get_repo_map` at `repomap.py:103-167` orchestrates all of the above and
  returns a formatted string block for injection into the LLM prompt.

### Verdict: 🟡 GRAFTABLE-LATER (not architecture-shaping)

Be honest about the fit: Aider's repo-map exists because Aider's LLM has **no native tool-use
loop** — the model gets one shot at a prompt and must infer what to edit from a static text
blob. **`claude -p` is fundamentally different**: it runs its own agentic loop with Read/Grep/
Glob tools and explores the repo live, deciding what to open based on what it finds. Feeding it
a static PageRank-selected map is not required for correctness, and duplicates work the model
already does better contextually (it can re-grep after finding something interesting; a
pregenerated map can't).

Where this *could* still add value later: (a) as an optional **task-prep hint file** written to
the blackboard before invoking `claude -p`, cheaply oriented via PageRank so the worker's first
few tool calls land closer to the relevant code in a large unfamiliar repo (reduces early
exploration turns/cost); (b) as a cost-reduction lever specifically for STATE/MODEL-ROUTING —
a cheap local static-analysis pass could substitute for some of the worker's own exploratory
tool calls, which cost tokens+latency on a paid API. Neither is required for Tier-1;
this is a "nice-to-have context accelerator," not a load-bearing seam. **Do not** build a
code-graph/context-selection subsystem into the worker-runner interface now — reconsider only
if profiling shows `claude -p` burning excessive turns on pure repo orientation in large repos.

---

## 3. Edit formats (aider/coders/)

Coder directory listing (`aider/coders/`) confirms four core format families plus "editor"
variants used in Aider's two-model architect/editor split: `editblock_coder.py`,
`wholefile_coder.py`, `udiff_coder.py`, `patch_coder.py`, plus fenced/func variants.

### SEARCH/REPLACE blocks — `editblock_coder.py` (`edit_format = "diff"`, line 18)
- `EditBlockCoder.get_edits` (`editblock_coder.py:21-36`) parses LLM output via
  `find_original_update_blocks(content, self.fence, ...)` (`editblock_coder.py:439`, not read
  in full but confirmed present) which extracts `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`
  fenced blocks per file.
- `EditBlockCoder.apply_edits` (`editblock_coder.py:41-124`) calls `do_replace(full_path,
  content, original, updated, self.fence)` (`editblock_coder.py:53, 364`) for each block; if
  the primary target file has no content, it retries against every other file the chat knows
  about (`editblock_coder.py:58-65`) — i.e. it tolerates the LLM naming the wrong file.
- **Fuzzy matching cascade** inside `replace_most_similar_chunk` (`editblock_coder.py:157-187`):
  1. exact match, then whitespace-normalized match (`perfect_or_whitespace`,
     `editblock_coder.py:164`); 2. retry after dropping a spurious leading blank line
     (`editblock_coder.py:168-173`); 3. `...`-elision matching for partial-context SEARCH
     blocks (`try_dotdotdots`, `editblock_coder.py:176-181, 190-241`).
  4. **Notably**, a Levenshtein/edit-distance fuzzy fallback (`replace_closest_edit_distance`)
     exists in the file (`editblock_coder.py:296-333`) but is **dead code** — it sits after an
     unconditional `return` at `editblock_coder.py:183`, so it never executes
     (`editblock_coder.py:184-187`). Aider's maintainers apparently disabled last-resort fuzzy
     matching in favor of failing loudly and asking the LLM to retry.
- On failure, `apply_edits` builds a detailed error message including "did you mean these
  lines" suggestions (`find_similar_lines`, `editblock_coder.py:98-106, 602`) and feeds it back
  to the LLM for self-correction (`editblock_coder.py:84-124`) — a **retry-via-conversation**
  pattern rather than a silent fallback.

### Whole-file rewrite — `wholefile_coder.py` (`edit_format = "whole"`, line 13)
- `WholeFileCoder.get_edits` (`wholefile_coder.py:22-122`) scans fenced code blocks and infers
  the filename from the line preceding the fence (`wholefile_coder.py:55-84`), with fallback
  heuristics (single chat file, last-mentioned filename) when no filename line is found.
- `apply_edits` (`wholefile_coder.py:124-128`) simply **overwrites the entire file** with
  `io.write_text`. No merge/patch logic — simplest and most token-expensive format, no
  ambiguity about "did the SEARCH block match."

### Unified diff — `udiff_coder.py` (`edit_format = "udiff"`, line 49)
- `UnifiedDiffCoder.get_edits` (`udiff_coder.py:52-67`) parses via `find_diffs(content)`
  (`udiff_coder.py:312`, hunk extraction from fenced `diff` blocks).
- `apply_edits` (`udiff_coder.py:69-118`) normalizes/dedupes hunks, then calls
  `do_replace(full_path, content, hunk)` (`udiff_coder.py:94, 121`) which in turn calls
  `directly_apply_hunk` / `apply_hunk` (`udiff_coder.py:151-201, 261-280`) with context-line
  matching (not strict `patch`-style line-offset application) and raises
  `SearchTextNotUnique` if a hunk's context matches more than once (`udiff_coder.py:95-100`).

### V4A-style patch format — `patch_coder.py` (explicitly ported code)
- `patch_coder.py:1-12` states in a comment: *"Domain objects & Exceptions (Adapted from
  apply_patch.py)"* — this is Aider's port of **OpenAI's `apply_patch` format** (Add/Delete/
  Update actions with `@@` context anchors), not an Aider invention
  (`patch_coder.py:10-11, 17-20`).
- `PatchCoder` class starts at `patch_coder.py:210`. Structured `PatchAction`/`Chunk`
  dataclasses (`patch_coder.py:24-47`) give it the most rigid/structured format of the four,
  trading flexibility for parse reliability.

### Per-model defaults (`aider/models.py`, `apply_generic_model_settings`, lines 437-595)
Confirmed mappings (all are `if <model-substring> in model: self.edit_format = ...` branches):
- `sonnet-4-`, `opus-4-`, `haiku-4-` → **`"diff"`** (SEARCH/REPLACE) (`models.py:531-543`).
- `3-7-sonnet`, `3.5-sonnet`/`3-5-sonnet` → **`"diff"`** (`models.py:545-559`).
- `gpt-5`/`gpt-5-2025-08-07`, `gpt-4.1`, `gpt-4.1-mini`, `o1`, `o1-preview`, `o3-mini`,
  `deepseek-v3`, `deepseek-r1`, `llama3-70b`, `gpt-4`/`claude-3-opus`, qwen coder/qwq/qwen3
  variants → also **`"diff"`** (`models.py:439-593` throughout).
- Only `gpt-4-turbo` / `gpt-4-*-preview` default to **`"udiff"`** (`models.py:515-519`).
- No model in this file defaults to `"whole"` or the raw patch format by substring match —
  those are opt-in / used by specific newer OpenAI-family configs elsewhere in resource files,
  not asserted here since not directly read.
- **Aider's own empirical conclusion, encoded in its defaults: SEARCH/REPLACE ("diff") is the
  default edit format for essentially every modern strong model it supports, including every
  Claude Sonnet/Opus 4.x variant** — this is a real, load-bearing signal about what format
  works best for the exact model family (`claude`) our own worker (`claude -p`) uses.

### Verdict: ⚪ REJECT for our architecture, with an honest caveat

**We don't control the worker's internal edit mechanism.** `claude -p` (Claude Code CLI) applies
edits itself via its own internal Edit/Write tool calls — it never emits SEARCH/REPLACE text
blocks or unified diffs for autodev-harness to parse and apply. None of `editblock_coder.py`,
`udiff_coder.py`, `patch_coder.py`'s *parsing/application* logic is directly portable into our
worker-runner, because we are never the one applying the edit — Claude Code already is.

What **is** interesting purely as reference, not as a component to build: (1) confirmation that
Anthropic's own Claude models are benchmarked by Aider as working best with SEARCH/REPLACE-style
localized edits rather than whole-file rewrites, which weakly validates that Claude Code's
internal Edit tool (also localized-diff-based) is the right mental model; (2) the retry-via-
conversation pattern (feed back "your SEARCH block didn't match, did you mean X" and let the
model self-correct) is a *generic* reliability idea that could apply anywhere we broker
LLM output against ground truth — e.g. if our **GATE** layer ever needs to ask codex to retry a
malformed review verdict. That's a stretch, not a direct steal. Overall: interesting prior art,
not a component we build.

---

## 4. Per-change git commit logic

### When Aider commits
- **After every LLM edit turn** (not after every user message, and not gated by any review):
  `Coder.run_one` (or its inner reply-processing path) calls `edited =
  self.apply_updates()` then immediately `self.auto_commit(edited)`
  (`aider/coders/base_coder.py:1585-1589`). A second commit can also happen after auto-lint
  fixes (`base_coder.py:1599-1601`, `context="Ran the linter"`).
- `Coder.auto_commit` (`base_coder.py:2375-2396`) guards on `self.auto_commits` (default
  `True`, `base_coder.py:308,412`) and `self.dry_run`, then calls
  `self.repo.commit(fnames=edited, context=context, aider_edits=True, coder=self)`
  (`base_coder.py:2383`).

### Commit message generation
- `GitRepo.commit` (`aider/repo.py:131-...`) calls `self.get_commit_message(diffs, context,
  user_language)` when no explicit message is passed (`repo.py:208-216`).
- `GitRepo.get_commit_message` (`repo.py:326-373`) makes a **separate LLM call** (loops over
  configured commit-message models, `repo.py:342-363`) with the diff + context as input and a
  templated system prompt (`self.commit_prompt or prompts.commit_system`, `repo.py:334`),
  falling back through multiple models if one exceeds its context window
  (`repo.py:355-359`). Strips surrounding quotes from the result (`repo.py:369-371`).
- Extensive attribution logic (author/committer name rewriting, `Co-authored-by:` trailer) is
  documented and implemented at `repo.py:131-230` — configurable via `--attribute-*` flags, not
  relevant to our architecture beyond noting Aider treats "AI-authored commit" as a first-class,
  auditable concept (a philosophy autodev-harness already embraces more strongly via **GATE**).

### Dirty-tree handling before starting an edit
- Aider does **not** stash or refuse on a dirty tree. `Coder.check_for_dirty_commit`
  (`base_coder.py:2175-2189`) detects if a file about to be edited is already dirty
  (`self.repo.is_dirty(path)`) and **auto-commits the pre-existing dirty state as its own
  commit** before applying the LLM's edit (`base_coder.py:2188-2189`, queued into
  `self.need_commit_before_edits`, flushed at `base_coder.py:2414-2419`). Rationale stated in a
  code comment: *"We need a committed copy of the file in order to /undo"* (`base_coder.py:2183`)
  — i.e. this exists purely to make Aider's own `/undo` command reliably revert exactly one
  logical AI-edit at a time, not for safety per se.

### Verdict: 🟡 GRAFTABLE-LATER as an *intermediate checkpoint* pattern, not as our commit model

autodev-harness's planned model is **gate-then-commit**: nothing lands in the mainline history
until an independent `codex exec` GPT-5.5 critic review passes (**GATE** → **CHECKPOINT**).
Aider's per-edit auto-commit is philosophically the opposite — it commits optimistically on every
turn with zero external review, relying on the user's live chat presence as the implicit gate.
Adopting per-edit-auto-commit as our *final* commit strategy would directly conflict with
**GATE** and should be rejected outright for that role.

However, the underlying mechanic — "commit early and often inside a worker's own session, purely
as rollback checkpoints, fully separate from the mainline branch/gate" — is a legitimately useful
pattern for **CHECKPOINT + ISOLATION**: inside an isolated worktree, a worker session could make
lightweight WIP commits (or the equivalent — a git stash ref, or blackboard-tracked file
snapshots) after each significant tool-use turn, purely so that if `claude -p` goes off the rails
mid-session we can cheaply roll back to the last good intermediate state *before* the critic even
sees the diff — without those WIP commits ever touching the branch that GATE reviews. This is
worth a backlog line item, not urgent for Tier-1. The dirty-tree pre-commit idea
(`check_for_dirty_commit`) is also a reasonable **ISOLATION** precondition check: before handing
a worktree to a worker, verify/commit or refuse on pre-existing dirt so the diff we later show
the critic is unambiguously attributable to the worker's own turn.

---

## 5. Model config / prompt caching / cost accounting

### Model metadata source
- Local settings file: `aider/resources/model-settings.yml`, loaded at import time into a
  module-level `MODEL_SETTINGS` list of `ModelSettings` dataclass instances
  (`aider/models.py:153-158`). This carries Aider-specific behavioral flags (`edit_format`,
  `use_repo_map`, `cache_control`, `reminder`, `examples_as_sys_msg`, etc. — dataclass fields
  visible at `models.py:140-150`).
- Pricing/context-window metadata comes from **litellm**, not a file Aider maintains itself:
  `ModelInfoManager` (`models.py:161-260`) fetches
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
  (`models.py:162-165`), caches it locally under `~/.aider/caches` with a 24h TTL
  (`models.py:166,169`), and falls back to `litellm.get_model_info(model)` directly if the
  cached JSON lookup misses (`models.py:252-261`).
- Runtime model-family dispatch happens in `Model.apply_generic_model_settings`
  (`models.py:437-595`), a long substring-matching cascade (see §3 above) that sets
  `edit_format`, `use_repo_map`, `use_temperature`, `reasoning_effort`/`thinking_tokens`
  support flags, etc. per model family.

### Prompt caching (Anthropic-style `cache_control`)
- `ChatChunks.add_cache_control_headers` (`aider/coders/chat_chunks.py:28-41`) places
  `cache_control: {"type": "ephemeral"}` breakpoints (`chat_chunks.py:43-55`) at up to four
  points in the message stack: end of system/examples block, end of repo-map+readonly-files
  block, and end of in-chat files block (`chat_chunks.py:29-41`) — this is Anthropic's
  documented prompt-caching mechanism (cache breakpoints on message boundaries), gated behind
  `self.main_model.cache_control` (`base_coder.py:426`) and only invoked when
  `cache_prompts` is enabled.
- Called from `Coder` at `base_coder.py:1336` (`chunks.add_cache_control_headers()`).
- Usage accounting reads back `cache_read_input_tokens` / `cache_creation_input_tokens` from
  the completion response (Anthropic's field names) or `prompt_cache_hit_tokens` (OpenAI/other
  provider naming) — both handled via `getattr` fallback chains at `base_coder.py:2003-2006,
  2082` and `models.py:1384` (paraphrased from grep hits, not fully re-read).

### Cost accounting
- `Coder.calculate_and_show_tokens_and_cost` (`base_coder.py:1994-2060+`) is the core function:
  pulls `prompt_tokens`/`completion_tokens`/cache tokens off `completion.usage`
  (`base_coder.py:2000-2006`), tries `litellm.completion_cost(completion_response=completion)`
  first (`base_coder.py:2037`), and falls back to `self.compute_costs_from_tokens(...)`
  (`base_coder.py:2042-2044`) using the model's own `input_cost_per_token` metadata
  (`base_coder.py:2031`) when litellm's built-in calculator fails (noted in a comment as
  "Seems to work for non-streaming only", `base_coder.py:2036`).
- Running totals: `self.total_cost` (session-lifetime, `base_coder.py:384,2046`) and
  `self.message_cost` (per-turn, reset each report, `base_coder.py:871,2047,2124`).
- `show_usage_report` (`base_coder.py:2102-2124`) surfaces both to the user/analytics layer.

### Reuse for autodev-harness
- **MODEL-ROUTING**: the `ModelSettings` dataclass + substring-cascade pattern
  (`models.py:437-595`) is a clean, portable *shape* for our own model-routing table (e.g. JSON/
  YAML keyed by model-name-substring → routing/complexity/cost hints), independent of the
  litellm dependency itself (we'd have our own pricing table for the two backends we actually
  call: `claude -p` and `codex exec`).
- **Cost tracking**: `calculate_and_show_tokens_and_cost`'s pattern (session-total + per-turn
  cost, cache-hit/write token breakdown, graceful fallback from provider-reported cost to
  manual price-table computation) is directly relevant to our blackboard's cost/economy axis —
  worth porting the *shape* of this accounting (not the litellm call) into our TS daemon.
- **Prompt caching**: not directly applicable as code (we don't construct raw Anthropic
  message arrays — `claude -p` handles its own prompt construction/caching internally), but
  the `cache_control` breakpoint placement strategy (system+examples / repo-context / chat-files
  as separate cache tiers) is a useful mental model if we ever build a lower-level Anthropic API
  integration (e.g. for the GATE critic's supporting context, or for a future non-CLI Claude
  backend).

Verdict: 🟡 GRAFTABLE-LATER for MODEL-ROUTING config shape and cost-accounting shape (both as
design patterns, re-implemented in TS, not copied code); ⚪ REJECT prompt-caching code directly
(irrelevant while `claude -p` owns its own prompt construction).

---

## 6. Worker-backend adapter feasibility

### Non-interactive CLI mode
- `--message`/`--msg`/`-m` (`aider/args.py:638-646`): *"Specify a single message to send the
  LLM, process reply then exit (disables chat mode)"* — genuine one-shot mode.
- `--message-file`/`-f` (`args.py:647-655`): same, reading the message from a file.
- `--exit` (`args.py:680-685`): *"Do all startup activities then exit before accepting user
  input (debug)"*.
- `--yes-always` (`args.py:759-764`): *"Always say yes to every confirmation"* — required to
  avoid interactive prompts (e.g. "create new file?", "allow edits to file not in chat?" seen
  at `base_coder.py:2207, 2226-2229`) when run headlessly.
- `--git`/`--no-git` (`args.py:404-409`, `BooleanOptionalAction`, default `True`): *"Enable/
  disable looking for a git repo"* — confirms a **git repo is expected but not hard-required**;
  Aider can run without one via `--no-git`, though auto-commit/dirty-tree features (§4) become
  inert in that mode.
- Wiring confirmed in `aider/main.py:1126-1134`: `if args.message: ... coder.run(with_message=
  args.message)` — this is the real non-interactive entry path.

### Python API / library usage without the REPL
- `aider/main.py:451`: `def main(argv=None, input=None, output=None, force_git_root=None,
  return_coder=False):` — a `return_coder=True` flag exists specifically to let a caller get
  back a constructed `Coder` object instead of entering the interactive loop
  (`main.py:1018-1020`: `if return_coder: ... return coder`). This is a genuine, intentional
  library-mode entry point, not a hack.
- The `Coder` object returned is fully constructed with model, repo, edit format, etc. already
  wired (see the `Coder(...)` call whose kwargs are visible ending at `main.py:1000-1007`); a
  caller can then call `coder.run(with_message="...")` programmatically exactly as the CLI does
  internally at `main.py:1130`.

### Shelling out: `aider --message "..." --yes-always --no-git` (or with git)
Practical requirements/gotchas surfaced by the above:
- Must run inside (or point `--no-git` outside) a git working tree; if a git repo exists, Aider
  will use its own commit machinery unconditionally on edits unless `--no-auto-commit`-style
  flags are also passed (not located in this pass, but `auto_commits` defaults `True`,
  `base_coder.py:308`) — meaning a naive shell-out would create commits autodev-harness didn't
  ask for, directly clashing with our **gate-then-commit CHECKPOINT** model. We'd need to pass
  whatever flag disables `auto_commits` (or run with `--no-git` and manage the diff/commit
  ourselves entirely outside Aider) if Aider were ever wired in as a backend.
- **Provider credentials**: Aider (via litellm) still needs environment-provided
  API keys for whatever `--model` is selected — exactly analogous to `claude -p` needing
  `ANTHROPIC_API_KEY`, so this is not an incremental integration cost, just a parallel one.
- Output capture: `--message` mode prints the assistant's reply and the diff/edit summary to
  stdout in the same way the interactive REPL would render it — parseable but not structured
  JSON; we'd need to either grep its console output or use the `return_coder=True` **Python API
  path** (requires embedding a Python subprocess or a small Python shim inside our Node daemon,
  since autodev-harness itself is TypeScript, not Python).

### Verdict: 🟡 GRAFTABLE-LATER (viable backlog item), not 🔴 architecture-shaping now

Aider is genuinely scriptable — `--message` + `--yes-always` + `--exit`/`return_coder` are real,
intentional non-interactive surfaces, not workarounds. It is technically feasible to add Aider as
a second `WORKER-BACKEND` behind our worker-runner interface, either via CLI shell-out
(`aider --message ... --yes-always`, capturing stdout + `git diff`) or, more robustly, via a thin
Python subprocess shim using `return_coder=True` for structured access to the `Coder` object.
That said: (1) it's a **second language runtime** (Python) our otherwise-Node daemon would need
to shell out to, which is exactly the kind of cross-language operational cost that should be
justified by a concrete need, not spec'd in speculatively; (2) its auto-commit behavior actively
fights our gate-then-commit philosophy and would need explicit suppression; (3) we have no
current requirement driving multi-backend worker support. **Recommendation: do not design the
worker-backend interface around Aider's specific quirks now** — keep the worker-runner
interface backend-agnostic (message-in, diff-out, exit-code-based success signal) so that Aider
(or any other CLI-scriptable coding agent) could be slotted in later without a redesign, but treat
actually wiring it up as a clearly-labeled backlog item, not Tier-1 scope.

---

## Top steals ranked

1. **🟡 Personalized-PageRank repo-map as an optional pre-worker context accelerator**
   (`aider/repomap.py:365-574` ranking, `repomap.py:629-706` binary-search token-budget fit).
   Justification: real, working, well-isolated algorithm (tree-sitter tags → weighted graph →
   personalized PageRank → binary-search-fit tree render) that could shave early
   exploration turns off `claude -p` sessions in large unfamiliar repos, purely as a
   cost/latency optimization layered onto STATE/MODEL-ROUTING — never required for
   correctness since `claude -p` explores live regardless.

2. **🟡 Cost-accounting + model-routing config shape** (`aider/models.py:140-158` `ModelSettings`
   dataclass + YAML table; `base_coder.py:1994-2060` `calculate_and_show_tokens_and_cost`).
   Justification: directly maps onto our MODEL-ROUTING and cost/economy blackboard axis — the
   *shape* (per-model substring-matched settings table; session-total + per-turn cost with
   cache-hit/write breakdown and provider-cost-API-with-fallback pattern) is reusable
   architecture even though the litellm dependency itself is not.

3. **🟡 Intermediate WIP-commit-as-rollback-checkpoint pattern, decoupled from GATE**
   (`aider/coders/base_coder.py:2175-2189` `check_for_dirty_commit`; `base_coder.py:1585-1589`
   per-turn `auto_commit`). Justification: not our final commit model (conflicts with
   gate-then-commit), but the underlying idea — cheap, frequent checkpoints *inside* an
   isolated worker session, fully separate from the branch the critic reviews — is a legitimate
   CHECKPOINT/ISOLATION safety net worth a backlog line.

4. **🟡 Aider as a second WORKER-BACKEND via `--message`/`--yes-always`/`return_coder=True`**
   (`aider/args.py:638-685,759-764`; `aider/main.py:451,1018-1020,1126-1134`). Justification:
   genuinely scriptable non-interactive surface exists; useful precedent for keeping our
   worker-runner interface backend-agnostic, but not worth building now absent a concrete need.

5. **⚪ SEARCH/REPLACE ("diff") as Aider's empirically-chosen default edit format for every
   Claude 4.x model** (`aider/models.py:531-559`). Justification: not a component we build
   (`claude -p` applies its own edits), but a useful *validation signal* that Anthropic models
   are best matched to localized-diff-style edits — consistent with how Claude Code's own Edit
   tool already behaves, so no action needed, just confirms our worker choice isn't
   fighting the grain of the model family.

---

## Anti-patterns to avoid

- **Per-edit auto-commit with no external review** (`base_coder.py:1585-1589`,
  `repo.py:131-373`). Aider commits on every LLM turn using an LLM-generated commit message,
  with the human chat session as the only "gate." For autodev-harness this is backwards: commits
  must only land after an **independent** `codex exec` GPT-5.5 review passes. Copying this
  pattern wholesale would silently reintroduce "trust the worker's own self-report" — precisely
  the failure mode gate-then-commit exists to prevent. If we borrow the checkpoint *mechanism*
  (see steal #3), it must never be conflated with, or substitute for, the final GATE-gated
  commit.
- **LLM-generated commit messages with no independent validation** (`repo.py:326-373`,
  `get_commit_message`). The message is produced by asking a model to describe its own diff —
  there's no cross-check that the message accurately reflects what changed, and no way to a
  reject a misleading self-description before it's baked into the message pointed at HEAD. Any
  commit-message generation we build should still originate its final wording from
  post-GATE tooling (or at minimum, be reviewable/overridable by the critic pass), not be
  treated as ground truth just because an LLM wrote it.
- **(Minor) Dead fuzzy-matching code left unconditionally unreachable**
  (`editblock_coder.py:183-187`) — a `return` statement makes 30+ lines of edit-distance fallback
  logic permanently dead. Not a design anti-pattern to copy so much as a reminder to keep our own
  worker-runner/gate logic free of similarly silent no-ops; if we ever disable a fallback
  path, remove it or gate it with a config flag rather than leaving unreachable code that looks
  load-bearing to a future reader.
