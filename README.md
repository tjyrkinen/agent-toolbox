# agent-toolbox

Things I've built for coding agents — skills, agents, hooks and references — put here to show
people. Written against the [Claude Code](https://claude.com/claude-code) skill format; the
mechanisms underneath are plain Python, HTML and shell.

| | |
| --- | --- |
| [`skills/interactive-page`](skills/interactive-page) | Serve a page on a local port and get the user's committed input back as JSON — sliders, a color picker, a triage list, inline comments on a document. No MCP, stdlib only. |

## interactive-page

`SKILL.md` is the definition, `references/page-contract.md` the payload and page contract. To see it
run:

```bash
cd skills/interactive-page
python3 scripts/serve.py --page assets/scaffold.html --data examples/demo.json --out /tmp/answer.json
```

Open a printed `URL`, commit, read `/tmp/answer.json`. Tests: `python3 scripts/test_serve.py`.

## License

[MIT](LICENSE).
