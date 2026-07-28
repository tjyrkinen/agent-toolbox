---
name: interactive-page
description: >-
  Serve a rendered HTML page on a local port and get the user's committed input back into the
  session, with no MCP. Reach for it when the input needs an interactive surface to express —
  because the subject is rich, visual, continuous, spatial, or high-volume: a color picker,
  sliders or parameter tuning with live preview, a canvas or sketch, dragging to arrange or rank,
  picking a point/region on an image or map, a many-field or many-row editor, critiquing a
  document/plan/spec by highlighting spans and commenting inline, or a decision surface the user
  toggles and annotates. The user manipulates real controls and the structured result posts back
  through a relative fetch; this skill waits for the commit and reads the JSON.
  NOT for read-only or shareable output (use the Artifact tool). NOT when the input reduces to a
  few discrete labeled choices a text prompt conveys — that is AskUserQuestion. The deciding
  factor is the subject's richness and volume, not the number of options.
allowed-tools: Bash, Write, Read, Edit, Monitor
---

# Interactive page

Turn a rendered page into a two-way control: the user manipulates whatever the subject calls for
— a color wheel, sliders, a canvas, drag-to-arrange, a map pin, or toggles and note fields — and
their committed result returns to you as structured JSON. Fit the surface to the subject; the
item-list scaffold below is the common case, not the ceiling. The medium is a local web server —
the one channel that reaches back into the session (an Artifact's sandbox CSP blocks every
network call, so it can look interactive but can never report anything back).

Full mechanics, payload shape, the `PAGE_DATA` schema, and the footer-action trust boundary are in
[references/page-contract.md](references/page-contract.md) — read it before first use.

## Workflow

1. **Shape the data.** Decide the items and footer actions. For the common "list of items, each
   with a toggle + options + a note" case, build a `PAGE_DATA` JSON and reuse
   `assets/scaffold.html`. For anything else, author a bespoke page against the contract.
2. **Serve it backgrounded** with `scripts/serve.py` (Bash `run_in_background: true`). Give
   each run a new output path:
   `python3 scripts/serve.py --page <page> [--data data.json] --out tmp/interactive-page-<run-id>/answer.json --port <p>`.
3. **Hand over the URL.** Present the printed **PRIMARY** address and **loopback** as fallback;
   expose the remaining `URL` lines only if those fail. The reachable interface is
   environment-specific — surface the candidates, do not guess one and drop the rest.
4. **Wait for the server's `COMMITTED` exit**, then **read that run's output file** and act on `actionKind`
   (`cancel` → nothing · `discuss` → return to chat, act on nothing · `primary`/`danger` → the
   commit is the sign-off; perform the action). Never act before the commit lands.

## Inline annotations (highlight & comment)

Every served page gets a highlight-and-comment toolbox by default (pass `--no-annotate` to disable).
It stays invisible until the user selects text, so it never clutters a page nobody annotates. The
user highlights any span and comments; the committed payload gains an `annotations[]` array anchored
by block id + quote + prefix/suffix + offsets, under its own key a consumer can ignore. For
critiquing a document, serve `assets/doc-scaffold.html` with the text as `--data` — the turnkey
plan/spec review path. Details and the anchor schema are in
[references/page-contract.md](references/page-contract.md).

## Guardrails

- **The commit is the only authorization.** A `primary`/`danger` commit stands in for the user's
  go-ahead, so an outward or irreversible action must have its own confirm on the page and an
  honest button label. When "talk it over first" is a real option, include a `discuss` action.
- **Never act on a page you did not serve this run.** The server rejects an existing output path,
  accepts only the first valid submission, and requires the run's nonce.
- **Read-only or shareable output is not this skill** — build an Artifact instead. This skill is
  only for input that must come back to the agent.
- **Reachability is surfaced, not assumed.** Print and relay every candidate URL; the page's
  relative `fetch` means whichever one loads is the one that commits back.

## Reuse by other skills

Any task where the user is better off manipulating the input than describing it can render here —
emit the surface, serve it, read `answer.json`. The item-list scaffold covers toggle/annotate
cases (a triage list, a bulk-edit table, a settings screen); a bespoke page covers the rest (a
color picker, a parameter-tuning panel, a drag-to-rank board). A code-review skill can use it as
its sign-off surface, a cleanup skill as its confirm-what-to-delete list; the pattern — build the
surface → serve → wait → consume the committed JSON — is the same regardless of shape.
