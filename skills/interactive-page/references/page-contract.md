# Interactive-page contract

The round-trip is: **serve a page locally → user toggles/annotates/commits → the
committed JSON lands in a file → the calling skill reads it and acts.** No MCP.

## Agent-side flow

1. **Build the data.** Create a run-scoped scratch directory and write the `PAGE_DATA` JSON
   (schema below) to its `data.json`.
2. **Serve it (backgrounded):**
   ```
   python3 <skill>/scripts/serve.py \
     --page <skill>/assets/scaffold.html --data tmp/interactive-page-<run-id>/data.json \
     --out tmp/interactive-page-<run-id>/answer.json --port <fixed-port>
   ```
   Run with Bash `run_in_background: true`. The server injects the nonce + data, then prints
   `NONCE`, `PORT`, `PRIMARY <ip>`, one `URL …` line per candidate address, and `READY`.
3. **Give the user the URL.** Present the **PRIMARY** url prominently and **loopback** as a
   fallback; both come from the printed lines. If the user reports neither loads, surface the
   remaining `URL` lines — the reachable interface varies by environment (container, VM, WSL,
   remote host). Never cherry-pick one address and hide the rest.
4. **Wait for the commit.** The server rejects an existing `--out`, accepts the first valid
   `/submit`, writes the run-scoped output, prints `COMMITTED`, and exits. Wait for the
   background task's completion notification; file existence alone is not authorization.
5. **Read that run's output and act by `actionKind`** (below). The payload never contains the nonce.

## Committed payload (what you read from `--out`)

```json
{
  "action": "signoff",            // the footer button's id
  "actionKind": "primary",        // cancel | discuss | primary | danger — drives what you do
  "generalNote": "free text",     // the overall note box ('' if hidden)
  "event": "REQUEST_CHANGES",     // derived: REQUEST_CHANGES if any included item mode==request_changes, else APPROVE
  "items": [
    { "id": "ask-2", "kind": "ask", "title": "…", "loc": "file:line",
      "include": true, "mode": "request_changes", "note": "per-item instruction" }
  ]
}
```

## Footer-action semantics (the trust boundary)

Read `actionKind`, not the label:

| actionKind | meaning | what the agent does |
| --- | --- | --- |
| `cancel`  | abort | do nothing; leave the world unchanged |
| `discuss` | not-yet | bring the selections + notes back into chat; act on **nothing** until the user agrees |
| `primary` / `danger` | sign-off | this **is** the authorization — perform the side effect using the committed items/notes |

`primary` = the page carried the confirmation, so the commit authorizes the action (post the
review, send the mail). Give an outward/irreversible page its own confirm affordance and label the
button honestly ("Sign off & act"). A page for a reversible action can use a single `primary`
"Commit". Offer `discuss` whenever "let me think / talk it over" is a real path.

## PAGE_DATA schema (for the shipped scaffold)

```jsonc
{
  "eyebrow": "…", "title": "…", "subtitle": "…",           // header (subtitle optional)
  "banner": { "text": "…", "tone": "amber|info" },          // optional callout
  "verdict": { "label": "VERDICT: NEEDS-YOU", "tone": "amber|green|red" }, // optional
  "sections": [                                              // optional read-only context
    { "label": "On approve, this gets posted", "body": "…", "format": "pre|text" }
  ],
  "sectionLabel": "Asks — toggle what to post",
  "notePlaceholder": "…", "generalNotePlaceholder": "…", "hideGeneralNote": false,
  "footer": [                                               // omit → Cancel / Discuss / Commit
    { "id": "cancel",  "label": "Cancel",         "kind": "cancel"  },
    { "id": "discuss", "label": "Discuss first",  "kind": "discuss" },
    { "id": "signoff", "label": "Sign off & act", "kind": "primary" }
  ],
  "items": [
    {
      "id": "ask-2", "num": "2", "group": "Infra", "kind": "ask|needs|plain",
      "title": "one-line action in domain terms",
      "loc": "src/lib/util.ts:20", "link": "https://github.com/…#L20",
      "badge": { "kind": "validated|refuted|neutral", "label": "verified", "reason": "…" },
      "include": true,                                       // default toggle state
      "modes": ["comment", "request_changes"],              // optional segmented control
      "mode": "request_changes",                            // default segment
      "modeLabels": { "comment": "Comment", "request_changes": "Request changes" }
    }
  ]
}
```

Each item renders as an include toggle + optional mode segments + a per-item note box. The user
never types numbers — they operate the controls and the structured result comes back to you.

## Bespoke pages (scaffold optional)

The scaffold is a convenience. Any page works if it:
- resolves its nonce from the `"__NONCE__"` injection token **or** `?n=` in the URL,
- POSTs to the **relative** `/submit` with a body object carrying `{ "nonce": <that>, … }`,
- shows a terminal "returned to chat" state after a 200.

Serve it the same way (`--page your.html`, omit `--data` if it needs none).

## Inline annotations — highlight & comment on any content

A drop-in toolbox lets the user highlight any span of the page and attach a comment, with **zero
page code**. It is injected into **every served page by default** (disable with `--no-annotate`);
scope it with `--annotate-root "<selector>"` (default `[data-annotate]` → `main` → `body`). It is
invisible until the user acts — the comment chip appears only on a text selection, the comments list
only once a comment exists — so it adds no clutter to pages nobody annotates, and its output is a
separate `annotations` key a consumer can ignore. The module (`assets/annotate.js`, injected before
`</body>`):

- turns a text selection into a "Comment" affordance → highlight + popover → a corner comment list,
- highlights via the CSS Custom Highlight API (no DOM surgery; spans element boundaries),
- **rides the page's commit**: patches `fetch` so annotations merge into any POST to `/submit` with a
  JSON-string body (the scaffolds use exactly that), and exposes `window.__getAnnotations__()`. If the
  page has no commit of its own, the module adds its own Cancel / Discuss / Submit bar so comments
  still return (suppressed when the page has a `.bar` footer, or when served with `--no-annotate-commit`).

The committed payload gains an `annotations` array:

```json
"annotations": [
  { "id": "an1", "comment": "…", "quotedText": "the highlighted text",
    "anchor": { "blockId": "b1", "blockIds": ["b1"], "quote": "the highlighted text",
                "prefix": "up to 32 chars before", "suffix": "up to 32 chars after",
                "start": 13, "end": 26 } }
]
```

**Resolving an anchor back to source:** `blockId` is `b<N>` = the Nth *leaf* text block in document
order (0-based) within the annotated region — for the document scaffold that is source line N (or
`blocks[N]`), so it maps straight back. Blocks numbered after the initial pass (content rendered
later, or markup the block selector doesn't recognize, which is anchored on first annotation) get
first-seen rather than document order, so resolve those by `quote`. `start`/`end` are char offsets
within the block's pure text.
When a selection spans blocks (`multiBlock: true`), `blockIds` lists every block covered, `start` is
an offset in the FIRST block and `end` in the LAST, and `quote` is the raw cross-block text (block
boundaries unmarked) — resolve it via `blockIds` + offsets, not one string search. For a hand-authored
page with no stable blocks, locate a single-block `quote` by search, disambiguating with `prefix`/`suffix`.

**Document critique (turnkey):** serve `assets/doc-scaffold.html` with
`--data doc.json` where `doc.json` = `{ title, subtitle?, instruction?, text | blocks[], footer? }`.
It renders the text as line-numbered, addressable blocks inside `data-annotate` (so the toolbox
auto-injects) with a Cancel / Discuss / Submit footer — the fast path for reviewing a plan or spec.

## Security

Loopback-friendly but bound to `0.0.0.0` so it crosses the VM boundary. A **nonce** embedded only
in the served URL is required before the server returns the page, and the same nonce is required
in `/submit`. A stray page in the same browser can *send* a cross-origin POST (CORS only blocks
reading the reply) but cannot load the page or authorize a commit without the nonce. Submit bodies
are capped at 1 MiB and read with a request timeout. The output path must be new, and the first
valid submission claims the run; later submissions receive 409. Single-shot: one commit per run,
then the port frees.
