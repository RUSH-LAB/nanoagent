---
name: read-arxiv-paper
description: 'Download an arxiv paper LaTeX source, organize it in raw/arxiv/ with a descriptive folder name, and compile the PDF. Use when the user wants to read, download, or work with an arxiv paper. Trigger on: arxiv IDs (e.g. 2301.12345), arxiv URLs, or requests mentioning "arxiv paper".'
---

# Read Arxiv Paper

Download an arxiv paper's LaTeX source code, organize it locally, and compile the PDF for reading.

## Input

The user provides one of:
- An **arxiv ID** (e.g. `2301.12345`, `2301.12345v2`)
- An **arxiv URL** (e.g. `https://arxiv.org/abs/2301.12345`)
- A **paper title or topic** to search for

## Workflow

### 1. Resolve the arxiv ID

If the user gave a URL, extract the ID from it (the part after `/abs/` or `/pdf/`).

If the user gave a title or topic instead of an ID, use the arxiv API to search:

```bash
curl -s "http://export.arxiv.org/api/query?search_query=ti:%22<TITLE>%22&max_results=5" | head -100
```

Present the top results and let the user pick one. Extract the arxiv ID from the chosen entry's `<id>` tag.

### 2. Fetch paper metadata

```bash
curl -s "http://export.arxiv.org/api/query?id_list=<ARXIV_ID>" | head -60
```

Extract from the XML response:
- **Title**: from `<title>` tag
- **Authors**: from `<author><name>` tags
- **Year**: from `<published>` tag (take the year portion)
- **Abstract**: from `<summary>` tag

Display this info to the user for confirmation.

### 3. Determine the folder name

Create a short, recognizable name in the format: `<short-name>-<year>`

Guidelines for `<short-name>`:
- Use the paper's commonly known abbreviation if it has one (e.g. "attention-is-all-you-need" → `transformer`, "BERT" → `bert`)
- Otherwise, derive a concise 1-3 word kebab-case slug from the title
- Keep it memorable and searchable

Ask the user to confirm or adjust the folder name.

### 4. Download the LaTeX source

```bash
mkdir -p raw/arxiv/<folder-name>
curl -L -o raw/arxiv/<folder-name>/source.tar.gz "https://arxiv.org/e-print/<ARXIV_ID>"
```

Then extract:

```bash
cd raw/arxiv/<folder-name>
tar xzf source.tar.gz
rm source.tar.gz
```

Note: Some papers use `.tar` without gzip. If `tar xzf` fails, try:

```bash
tar xf source.tar.gz
```

If that also fails, the download might be a single `.tex` file (not an archive). Check with `file source.tar.gz` and rename accordingly.

### 5. Compile the PDF

Try compilation in this order:

```bash
cd raw/arxiv/<folder-name>
```

**Option A: latexmk (preferred)**
```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error *.tex
```

If there are multiple `.tex` files, identify the main one (usually contains `\documentclass` and `\begin{document}`) and compile that specifically.

**Option B: pdflatex fallback**
```bash
pdflatex -interaction=nonstopmode <main>.tex
bibtex <main> 2>/dev/null || true
pdflatex -interaction=nonstopmode <main>.tex
pdflatex -interaction=nonstopmode <main>.tex
```

**Option C: If the paper uses special fonts or Unicode**
```bash
xelatex -interaction=nonstopmode <main>.tex
```

### 6. Download GitHub code (if available)

Check whether the paper has an associated GitHub repository. Look for GitHub links in:
1. The arxiv abstract (already fetched in step 2)
2. The LaTeX source files (grep for `github.com` in `.tex` files)

```bash
grep -roh 'https\?://github\.com/[A-Za-z0-9_.-]*/[A-Za-z0-9_.-]*' raw/arxiv/<folder-name>/*.tex 2>/dev/null | sort -u
```

If a GitHub repo is found, download it as a zip archive (not `git clone`, to avoid `.git` overhead):

```bash
mkdir -p raw/github/<folder-name>
curl -L --max-time 120 -o /tmp/<folder-name>.zip "https://github.com/<owner>/<repo>/archive/refs/heads/main.zip"
```

If the `main` branch 404s, try `master`:

```bash
curl -L --max-time 120 -o /tmp/<folder-name>.zip "https://github.com/<owner>/<repo>/archive/refs/heads/master.zip"
```

Then extract and flatten into the target folder:

```bash
unzip -q /tmp/<folder-name>.zip -d /tmp/<folder-name>-extract
mv /tmp/<folder-name>-extract/*/* raw/github/<folder-name>/
rm -rf /tmp/<folder-name>.zip /tmp/<folder-name>-extract
```

If no GitHub repo is found, skip this step silently.

### 7. Verify and report

After compilation, check that a PDF was produced:

```bash
ls -la raw/arxiv/<folder-name>/*.pdf
```

Report to the user:
- The folder path: `raw/arxiv/<folder-name>/`
- The PDF path for reading
- Paper title, authors, and year
- GitHub code path (if downloaded): `raw/github/<folder-name>/`

If compilation fails, still keep the source files and inform the user. The source is valuable even without a compiled PDF. Offer to open the arxiv PDF URL as a fallback: `https://arxiv.org/pdf/<ARXIV_ID>`

## Directory Structure

All papers go under `raw/arxiv/` at the project root. The `raw/` directory is gitignored.

```
raw/
  arxiv/
    transformer-2017/
      *.tex
      *.bib
      *.sty
      *.pdf  (compiled)
    bert-2018/
      ...
  github/
    transformer-2017/
      (repo contents, no .git)
    bert-2018/
      ...
```

## Notes

- Always run commands from the project root: `/Users/zy45/Documents/Code/mochi-lab/`
- The `raw/` directory is in `.gitignore`, so nothing here gets committed
- If a paper's source is not available on arxiv (rare), download the PDF directly instead
- Timeout for `curl` downloads: add `--max-time 60` for large files
- For compilation, use `--interaction=nonstopmode` to avoid hanging on prompts
