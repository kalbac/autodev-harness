# Donor Reference Clones — Manifest

> Local, read-only copies of donor-candidate codebases used for the **Donor
> Extraction pass** (deciding what "best" pieces the harness takes from each).
> These clones are **git-ignored** (see `.gitignore`) — they are NOT part of the
> `autodev-harness` history. Reproduce any clone from the URL + pinned SHA below.
>
> Clones are shallow (`--depth 1`); the pinned SHA is the commit that was HEAD at
> clone time, recorded for reproducibility. To study history, re-clone without
> `--depth`.

## Clones

| Dir | Repo | Pinned SHA (HEAD at 2026-07-01) | License | Role |
|---|---|---|---|---|
| `agent-orchestrator/` | github.com/AgentWrapper/agent-orchestrator | `6a7ba460788e18ad2216b9beaf70afaf07cfd6c4` | TBD (agent to confirm) | Body/UI/kanban/session-PR/worktree |
| `OpenHands/` | github.com/All-Hands-AI/OpenHands | `c105a82387898e744423c8831d412e26495b38a9` | MIT | "Agent Canvas" control-center shell (real agent code moved out — see below) |
| `software-agent-sdk/` | github.com/OpenHands/software-agent-sdk | `feca62017e2d33519c953b83f3747ded6b96329d` | MIT | **The actual OpenHands intelligence** (event-stream, risk/ensemble gate, ACP agent, LiteLLM RouterLLM). Pulled into OpenHands as PyPI pkgs; cloned here for source study. |
| `open-design/` | github.com/nexu-io/open-design | `56c410e9ef5edee9d01f8766248346f8be71bf9d` | Apache-2.0 | UX/extensibility (agent auto-detect, 3-tier UI, model router, skills/plugins/MCP) |
| `aider/` | github.com/Aider-AI/aider | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Apache-2.0 | Worker edit quality/economy (repo-map, edit formats, per-change commits) |

## Not-a-clone: our own proven loop

The 5th "donor" is our own **autodev-loop** — the live PowerShell implementation
at `D:/Projects/woodev_framework/tools/autodev/*.ps1` (~2900 LOC, ran s1–s7 on
woodev_framework). It is the harness's **base**, not a clone; its behaviour is the
parity spec the new TS core must match. Studied in place (not copied here).

## Adding a future donor

1. `git clone --depth 1 <url> references/<dir>`
2. Record `<dir>`, URL, HEAD SHA, license, one-line role in the table above.
3. Run a donor-study agent against it (see the extraction brief in the session /
   `docs/superpowers/specs/`).
