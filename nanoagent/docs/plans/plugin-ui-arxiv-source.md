# Plan: the arxiv-source page (`plugins/arxiv-source/ui/`)

The page is one chat with the plugin's agent (`chatLayout`, docs/plans/plugin-ui.md). People say
what they want in their own words; the agent picks the tools. What the tools return is drawn as
cards above the agent's answer, so nobody reads JSON, tool names or arXiv query syntax.

## The user job

> "I want the source of *that* paper (or of these few papers), and every morning I want to know
> what the people I follow put out yesterday, with the sources already saved."

Both jobs are a sentence in the chat: "find the paper that introduced …", "save the source of
arXiv 1706.03762", "write a digest of yesterday's papers by Yoshua Bengio and Yann LeCun".

## The cards

`app.js` gives `chatLayout` one renderer per tool (`render`); a tool's output is contract.py's.

| Tool | Card |
|---|---|
| `search_papers` | "N papers found" and the query; each paper's title (a link to its abstract page), authors (four, then "and N others"), date, id with a copy button, the abstract (two lines, "More"), and **Save source** (sends "Save the source of arXiv <id>." in the chat), PDF, Abstract. Five papers, then "Show N more". |
| `save_search_results` | "Saved N papers" and the folder; each paper with its folder and, behind a toggle, its files. |
| `download_source` | "Saved the source of <id>": the folder and its files. |
| `save_raw_paper` | "Saved the source": the paper, its folder and files. |
| `list_daily_papers` | "New papers on <date>": each person's papers. |
| `write_digest` | "Digest of N papers" and its path: the digest's Markdown. |

A failed tool call draws no card; the agent's answer says what went wrong. The session keeps each
turn's tool calls, so a resumed session draws its cards again.

Four suggestion chips put a starting sentence in the box (never send it): find a paper by
description, search a topic, save a paper's source, daily digest.

## Not on the page

No form, tabs, library or followed-people list: the agent is told the plugin's tasks and README,
and the workspace's file view shows what is saved.
