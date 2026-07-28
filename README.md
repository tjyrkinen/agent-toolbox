# agent-toolbox

Things I build to make coding agents more useful, published as I go — skills, agents, hooks, and
references. Each one stands alone: take the directory you want, ignore the rest.

Most of it is written against the [Claude Code](https://claude.com/claude-code) skill format
(`SKILL.md` + supporting files), but the mechanisms underneath are plain Python, HTML, and shell —
nothing stops another agent from using them.

| | What it is |
| --- | --- |
| [`skills/interactive-page`](skills/interactive-page) | Give the agent a real UI to ask you things with — sliders, a color picker, a canvas, a triage list, inline comments on a document — and get your answer back as structured JSON. No MCP, stdlib only. |

## interactive-page

An agent asking a text question is fine for "which of these three?" It is miserable for "what
shade of teal?", "rank these twelve", "which of these 40 findings should I post?", or "tell me
what's wrong with this plan, paragraph by paragraph."

This gives the agent a way out: it writes an HTML page, serves it on a local port, hands you the
URL, and blocks. You open it, manipulate real controls, and hit commit. The page POSTs to a
relative `/submit` on the same server that served it; the server writes the JSON to a file and
exits; the agent reads it and acts.

The relative POST is the whole trick — whichever address actually loads for you is the one that
answers back, so it works the same from a container, a VM, WSL, or another machine on the LAN.

**What you get:**

- `scripts/serve.py` — single-shot server. Python 3 stdlib, no dependencies. Injects a per-run
  nonce and your JSON data into the page, prints every candidate URL, waits for exactly one
  commit, writes it, exits.
- `assets/scaffold.html` — the common case, driven entirely by a JSON file: a list of items, each
  with an include toggle, optional segmented control, and a note box. Light/dark aware.
- `assets/doc-scaffold.html` — drop in a document and get it back line-numbered and annotatable.
- `assets/annotate.js` — highlight-and-comment, injected into *every* served page by default, even
  a page you hand-wrote. Select text → comment → the committed payload gains an `annotations[]`
  array anchored by quote + surrounding context + offsets. Invisible until you select something.
- `SKILL.md` / `references/page-contract.md` — the instructions the agent reads: payload shape,
  the `actionKind` trust boundary, how to author a bespoke page.

### Try it in 30 seconds

```bash
git clone https://github.com/tjyrkinen/agent-toolbox
cd agent-toolbox/skills/interactive-page

python3 scripts/serve.py \
  --page assets/scaffold.html \
  --data examples/demo.json \
  --out /tmp/answer.json
```

Open one of the printed `URL` lines, toggle a few things, select some text and comment on it, then
commit. The server exits and `/tmp/answer.json` holds what you decided. (Delete it before the next
run — a fresh output path is required, so a stale file can never be mistaken for a new answer.)

### Using it with Claude Code

```bash
git clone https://github.com/tjyrkinen/agent-toolbox /tmp/agent-toolbox
cp -r /tmp/agent-toolbox/skills/interactive-page ~/.claude/skills/    # or .claude/skills/ in a project
```

Restart the session and the skill is listed. The agent picks it up on its own when the input calls
for a surface rather than a sentence; you can also just say "ask me on an interactive page."

### Using it with any other agent

Nothing above is Claude-specific. Point your agent at `references/page-contract.md` and give it
shell access. The contract for a hand-written page is three lines: read the nonce from
`"__NONCE__"` or `?n=` in the URL, POST `{nonce, ...}` to the relative `/submit`, then show a
terminal "returned to chat" state.

### Trust boundary

`serve.py` binds `0.0.0.0` so it can cross a container or VM boundary. Access is gated on a
per-run nonce that exists only in the URL you were handed — required both to load the page and to
commit. Submissions are capped at 1 MiB, read with a timeout, and the first valid one claims the
run; the rest get a 409. The output path must not already exist.

Read `actionKind`, never the button label: `cancel` means do nothing, `discuss` means bring it
back to chat and act on nothing, `primary`/`danger` means the commit *is* the authorization.

### Tests

```bash
python3 skills/interactive-page/scripts/test_serve.py
```

Covers nonce enforcement, oversized and negative `Content-Length`, incomplete-body timeout,
concurrent double-submit, HTML-token escaping in injected data, and stale-output rejection.

## License

[MIT](LICENSE).
