---
slug: wikipedia-category-graph
title: "Taming the Wikipedia Category Graph: SOTA in Compression and Construction"
authors: [zeyu]
tags: [knowledge-graph, wikipedia, taxonomy, graph-compression]
---

**Why bother?** Wikipedia's raw `Category:` system is not actually a usable taxonomy: it is a cyclic graph that mixes `is-a`, `part-of`, and topical relations, conflates instances with classes, and has no consistent typing, so feeding it directly to a knowledge graph, an entity-typing system, or a hierarchical retriever produces garbage. **Construction** methods turn this soup into a clean DAG that you can actually reason over (`x is-a-kind-of y`), which is what powers entity typing in YAGO/CaLiGraph, hierarchical RAG, and ontology-grounded LLM agents. **Compression** matters because even the cleaned graph plus full article membership has billions of edges, and you want it to fit in memory next to your retriever or to be encoded into low-dimensional embeddings for fast subsumption queries.

<!-- truncate -->

Wikipedia's category system is one of the largest crowdsourced classification structures ever built: roughly 2.4M English categories connected by 5M+ subcategory links across 7M+ articles. It is also famously messy. Two decades of research have attacked this from two complementary directions: **graph construction** (turn the noisy category network into a clean ontology) and **graph compression** (store and traverse the resulting structure efficiently at scale). Here is where the state of the art sits today.

## How DBpedia Actually Extracts Wikipedia

Almost every system below either uses DBpedia as input or competes with it, so it is worth understanding what [`dbpedia/extraction-framework`](https://github.com/dbpedia/extraction-framework) (Scala, 933★, actively maintained) actually does. The pipeline:

1. **Ingest dumps.** Pull the periodic XML dumps that Wikipedia publishes (one per language) and stream the wikitext of each article through a tokenizer + parser. Live updates can also be consumed off the OAI-PMH stream for the "DBpedia Live" variant.
2. **Run a stack of extractors.** Each extractor is a small Scala module that walks the parsed wikitext and emits RDF triples. The important ones:
   - **InfoboxExtractor / MappingExtractor**: read `{{Infobox X}}` templates and emit `(subject, predicate, value)` triples. Mapping extractor uses crowd-curated *mappings* (see step 3) to produce *typed*, ontology-aligned triples; the generic infobox extractor falls back to raw property names when no mapping exists.
   - **CategoryExtractor**: for every `[[Category:Y]]` link, emit `<article> dcterms:subject <Category:Y>`; and for every parent category, emit `<Category:Y> skos:broader <Category:Z>`. **This is where the raw Wikipedia category graph enters DBpedia as the famous noisy `skos:broader` relation** that downstream systems (CaLiGraph, YAGO) then have to clean.
   - **LabelExtractor / AbstractExtractor / RedirectExtractor / DisambiguationExtractor / WikiPageLengthExtractor**: emit `rdfs:label`, the first-paragraph abstract, redirects, disambiguation links, etc.
   - **PageLinksExtractor / ExternalLinksExtractor**: emit `<a> dbo:wikiPageWikiLink <b>` for every internal link, and the external URL graph.
   - **GeoExtractor / HomepageExtractor / ImageExtractor**: emit coordinates, official URLs, depicted images from infobox conventions.
3. **Apply the community mappings.** The [mappings.dbpedia.org](https://mappings.dbpedia.org) wiki is a separate, crowd-edited site where contributors write rules like "the `birth_date` field of `Infobox person` maps to `dbo:birthDate (xsd:date)`, and the template implies `rdf:type dbo:Person`". The extraction-framework loads these mappings at run time and uses them to convert the messy per-template properties into the ~700-class DBpedia ontology with typed literals. This is what gives DBpedia its clean typed assertions; without mappings you only get string-valued `dbp:*` raw properties.
4. **Cross-language linking.** A separate extractor follows Wikipedia's interlanguage links and emits `owl:sameAs` triples between language editions, producing one DBpedia URI per concept across 100+ languages.
5. **Distribute.** The output `.ttl`/`.nt` files are published as versioned datasets on the [DBpedia Databus](https://github.com/dbpedia/databus), the team's content-addressed distribution platform, so downstream systems can pin to a specific snapshot.

The architecture is deliberately modular: every extractor is independent, you can run a subset, and adding a new one (e.g. an infobox-image-caption extractor) is ~100 lines of Scala. The trade-off is that DBpedia stops at *extraction*: it does **not** try to clean the category graph into a true taxonomy, validate logical consistency, or mine intensional definitions. That is exactly the gap the rest of this post is about: every system below treats DBpedia's output as the *starting* point and tries to fix what DBpedia deliberately leaves raw.

## TL;DR: What to Actually Use Today

| Need | Recommendation |
|---|---|
| A clean Wikipedia taxonomy, drop-in | **YAGO 4.5** if you want WordNet/Schema.org grounding; **CaLiGraph** if you want richer typing and list-page coverage. |
| Build your own from scratch | Start with CaLiGraph's pipeline (Cat2Ax + list pages), add an LLM verifier on the proposed `is-a` edges. |
| Store the full link/category graph | **WebGraph (BVGraph)** with Layered Label Propagation reordering. Use `webgraph-rs` if you are in Rust, the Java library otherwise. |
| Approximate / visualization-grade | SIGMOD 2024 graph summarization (Chu et al.). |
| Retrieval and reasoning | Hyperbolic or box embeddings over the cleaned DAG, indexed in a vector store. |

### Best Papers to Read

A focused reading list. If you read these in order, you will have the full picture.

| Paper | Year | Why it matters |
|---|---|---|
| [Deriving a Large-Scale Taxonomy from Wikipedia](https://cdn.aaai.org/AAAI/2007/AAAI07-228.pdf), Ponzetto & Strube | AAAI 2007 | The foundational paper. Establishes the lexico-syntactic + WordNet pipeline that every later system extends. |
| [YAGO: A Core of Semantic Knowledge](https://suchanek.name/work/publications/www-2007-yago.pdf), Suchanek, Kasneci, Weikum | WWW 2007 | Introduces the WordNet anchoring strategy that makes YAGO logically consistent. Read alongside the [YAGO 4.5 paper](https://yago-knowledge.org/data/yago4.5/yago-4-5-paper.pdf) (arXiv 2023, SIGIR 2024) for the modern release. |
| [Uncovering the Semantics of Wikipedia Categories (Cat2Ax)](https://arxiv.org/abs/1906.12089), Heist & Paulheim | ISWC 2019 | The key trick behind CaLiGraph: mine patterns in category *names* and validate them with statistics over category *members*. |
| [Entity Extraction from Wikipedia List Pages](https://link.springer.com/chapter/10.1007/978-3-030-49461-2_19), Heist & Paulheim | ESWC 2020 | Shows how to harvest typed entities from list pages, dramatically expanding long-tail coverage. |
| [CaLiGraph: A Knowledge Graph from Wikipedia Categories and Lists](https://madoc.bib.uni-mannheim.de/70765/1/heist-paulheim-2025-caligraph-a-knowledge-graph-from-wikipedia-categories-and-lists.pdf), Heist & Paulheim | SWJ 2025 | The current SOTA system paper. Read this if you only read one. |
| [The WebGraph Framework I: Compression Techniques](https://vigna.di.unimi.it/algoweb/WebGraph.pdf), Boldi & Vigna | WWW 2004 | The reference for lossless web-graph compression. Reference + gap + interval encoding, still the baseline. |
| [Zuckerli: A New Compressed Representation for Graphs](https://research.google/pubs/zuckerli-a-new-compressed-representation-for-graphs/), Versari et al. (Google) | 2020 | Improves WebGraph by 20–30% with better entropy coding and reorderings. |
| [WebGraph: The Next Generation (Is in Rust)](https://dl.acm.org/doi/10.1145/3589335.3651581), Boldi, Fontana, Vigna | WWW 2024 | The Rust rewrite. ~3× faster, same compression. Use this for new projects. |
| [Graph Summarization: Compactness Meets Efficiency](https://nedchu.github.io/sigmod2024.pdf), Chu et al. | SIGMOD 2024 | Current SOTA for lossy summarization at web scale. Near-linear time, near-optimal compactness. |
| [TaxoExpan: Self-supervised Taxonomy Expansion](https://arxiv.org/abs/2001.09522), Shen et al. | WWW 2020 | The reference GNN-based attachment model; still a strong baseline for adding new nodes. |
| [HiExpan: Task-Guided Taxonomy Construction by Hierarchical Tree Expansion](https://hanj.cs.illinois.edu/pdf/kdd18_jshen.pdf), Shen et al. | KDD 2018 | The original weakly-supervised tree-expansion framework, still influential. |
| [Poincaré Embeddings for Learning Hierarchical Representations](https://proceedings.neurips.cc/paper/2017/file/59dfa2df42d9e3d41f5b02bfc32229dd-Paper.pdf), Nickel & Kiela | NeurIPS 2017 | The paper that started the hyperbolic-embedding line for taxonomic data. |

### Best OSS Repos to Use

Sorted within each category by a mix of stars, recency, and relevance. Stars (★) and last-push date are a snapshot pulled from the GitHub API on 2026-05-21, so expect them to drift.

**Ontology construction (Wikipedia → clean KG)**

| Repo | ★ | Last push | What you get |
|---|---|---|---|
| [`dbpedia/extraction-framework`](https://github.com/dbpedia/extraction-framework) | 933 | 2026-03 | The DBpedia extraction pipeline. Source of truth for infobox-typed entities and the raw `skos:broader` category links. Actively maintained. |
| [`yago-naga/yago-4.5`](https://github.com/yago-naga/yago-4.5) | 70 | 2026-05 | YAGO 4.5 build scripts and downloads. Cleanest drop-in Wikipedia-derived taxonomy with strict OWL2 consistency. Updated this month. |
| [`dbpedia/databus`](https://github.com/dbpedia/databus) | 69 | 2025-12 | DBpedia's dataset distribution platform, where you actually fetch the RDF dumps. |
| [`nheist/CaLiGraph`](https://github.com/nheist/CaLiGraph) | 28 | 2023-06 | Full CaLiGraph pipeline (Cat2Ax + list-page extraction + axiomatization) plus released RDF dumps at [caligraph.org](https://caligraph.org/). Low stars because it is research code, but it is the SOTA construction system. |
| [`nheist/Cat2Ax`](https://github.com/nheist/Cat2Ax) | 7 | 2021-06 | The standalone Cat2Ax axiom-mining tool, if you only want that component. |
| [`yago-naga/yago3`](https://github.com/yago-naga/yago3) | 751 | 2022-07 | The older YAGO 3 codebase. High stars from years of use; superseded by YAGO 4.5 for new projects. |

**Graph compression**

| Repo | ★ | Last push | What you get |
|---|---|---|---|
| [`vigna/webgraph`](https://github.com/vigna/webgraph) | 83 | 2026-04 | Original Java WebGraph framework (BVGraph). Mature, battle-tested, still actively maintained. |
| [`vigna/webgraph-rs`](https://github.com/vigna/webgraph-rs) | 60 | 2026-05 | The 2024 Rust port. Faster, memory-safer, the recommended choice for new code. Updated this month. |
| [`google/zuckerli`](https://github.com/google/zuckerli) | 28 | 2022-09 | Google's improved compressed graph representation. ⚠️ **Archived** (usable as a reference, but no new development). |

**Taxonomy expansion / completion**

| Repo | ★ | Last push | What you get |
|---|---|---|---|
| [`mickeysjm/TaxoExpan`](https://github.com/mickeysjm/TaxoExpan) | 78 | 2021-11 | Reference implementation of the GNN taxonomy-attachment model. Older but still the standard baseline. |
| [`mickeysjm/HiExpan`](https://github.com/mickeysjm/HiExpan) | 73 | 2021-11 | Original hierarchical expansion framework, useful for bootstrapping domain taxonomies from seed sets. |

**Hierarchical embeddings**

| Repo | ★ | Last push | What you get |
|---|---|---|---|
| [`facebookresearch/poincare-embeddings`](https://github.com/facebookresearch/poincare-embeddings) | 1.7k | 2025-05 | Official PyTorch implementation of Poincaré/Lorentz embeddings. ⚠️ **Archived** but stable, still the canonical reference implementation; trains on the Wikipedia category DAG in a few hours on one GPU. |
| [`HazyResearch/KGEmb`](https://github.com/HazyResearch/KGEmb) | 256 | 2021-06 | Stanford HazyResearch's hyperbolic KG embedding library. Broader set of models (RotH, AttH, MuRP) than the original Poincaré repo. |
| [`amazon-science/hyperbolic-embeddings`](https://github.com/amazon-science/hyperbolic-embeddings) | 38 | 2025-06 | Amazon's hyperboloid embeddings for KG entities. Smaller, but currently maintained. |

---

## How Each SOTA Method Actually Works

A concrete walkthrough of the methods behind each paper above. Skim this if you want to know *what is doing the work* in each system.

### Construction methods

**Ponzetto & Strube (AAAI 2007): WikiTaxonomy.** A four-stage filter cascade applied to every `(child_cat, parent_cat)` link in Wikipedia:

1. **Syntactic match.** Parse each category name into modifier + head noun (`Capitals in Europe` → head `Capitals`). Keep the edge only if the heads match in lemma and number (plural-plural).
2. **Lexical match against connectives.** Look for `X of Y` / `X in Y` patterns; drop edges that look topical rather than `is-a`.
3. **Hearst patterns over the underlying Wikipedia text.** Confirm `is-a` with classic patterns like "X such as Y", "Y and other X".
4. **WordNet check.** Resolve heads to WordNet synsets; keep only edges consistent with WordNet's hypernymy.

Each filter is a vote; an edge survives if it passes a threshold. The output is a noisy DAG (cycles broken by minimum feedback arc set).

**YAGO / YAGO 4.5 (Suchanek et al., 2007 → arXiv 2023, SIGIR 2024).** YAGO does *not* trust category-name parsing. Instead, every Wikipedia category is mapped to a WordNet synset using head-noun + WSD, and the synset's hypernyms become the class hierarchy. YAGO 4.5 adds two more layers: (a) integrate the Wikidata class graph but *prune* it to remove the meta-level cruft (`Wikimedia disambiguation page` etc.), and (b) anchor the top of the resulting tree in Schema.org so every class has a clean upper-ontology root. The taxonomy is then *logically validated*: any class causing OWL2 inconsistency is dropped. The result is a small but provably consistent upper taxonomy (~10K cleaned top-level classes), under which the ~50M entities are typed.

**Cat2Ax (Heist & Paulheim, ISWC 2019).** The key insight: do not rely on category *names* alone; mine linguistic patterns in the names and then validate and weight them with statistics over category *members*. The paper runs three phases (candidate selection, pattern mining, pattern application). One core signal: for each category `C` and each property `p` in DBpedia, compute the fraction of `C`'s entities that share a value for `p`. If `≥ θ` of members of `Category:German jazz singers` have `nationality = Germany`, mine the axiom `C ⊑ ∃nationality.Germany`. Repeat for `type`, `genre`, etc. This produces a structured intensional definition of each category from statistics over its instances, which is then used to:

- *Type new entities* (an entity satisfying the axioms is a member),
- *Detect mis-classified entities* (members violating the axioms),
- *Infer subsumption* (`C1 ⊑ C2` when C1's axioms imply C2's).

**Entity Extraction from List Pages (Heist & Paulheim, ESWC 2020).** A Wikipedia list page (`List of German jazz singers`) is treated as a category whose membership is given explicitly by the list rows. The pipeline links list rows to Wikidata/DBpedia entities, applies Cat2Ax-style axiom mining to the list, and then asserts types for the linked entities. This is how CaLiGraph triples its typed-entity coverage versus DBpedia.

**CaLiGraph (SWJ 2025).** The full system glues the above together:

1. Build a unified candidate hierarchy from Wikipedia categories + list pages.
2. Run Cat2Ax to mine axioms per node.
3. Disambiguate instance-vs-class with a transformer classifier (head-noun + member-distribution features).
4. Resolve subsumption with a hybrid scorer: lexical head-match + axiom-implication + DBpedia/Wikidata grounding.
5. Materialize types and relations for every linked entity, including those harvested from list pages.

Output (v3.0): ~1.3M classes, ~15M entities, tens of millions of relation assertions, with the full ontology published as RDF.

**TaxoExpan (Shen et al., WWW 2020).** Frames taxonomy expansion as link prediction: given a query concept `q` and a candidate parent `a` in an existing taxonomy, predict whether `q is-a a`. The query is encoded by its text embedding; the candidate is encoded by a **position-enhanced GNN** over its local ego-network (parents, siblings, children), with positional features that tell the GNN where each neighbor sits relative to `a`. Training is self-supervised: hold out an existing edge `(c, p)`, treat `c` as the query, and learn to recover `p`. A noise-robust InfoNCE loss handles the fact that several plausible parents may exist.

**HiExpan (Shen et al., KDD 2018).** Builds a taxonomy from a small seed tree plus a raw corpus. Two operations alternate: **width expansion** (find new siblings of existing nodes via distributional similarity + SkipPattern mining over the corpus) and **depth expansion** (find new children for a node by mining `X such as Y` patterns and clustering the results). A global optimization re-attaches misplaced nodes after every iteration to keep the tree consistent.

**LLM-as-verifier hybrids (2023–25).** Generic recipe rather than a single paper: (a) cheap retriever or sentence-embedding model proposes top-`k` parent candidates for each new concept, (b) an LLM is prompted with the concept's definition and the candidate's definition and asked "is X a kind of Y? answer yes/no with a reason", (c) candidates passing the LLM check are added, with optional consistency checks (`A is-a B` and `B is-a C` must be mutually consistent). This is the pattern most production knowledge-graph teams have converged on in the last 18 months.

### Compression methods

**BVGraph / WebGraph (Boldi & Vigna, WWW 2004).** Compress an adjacency list `Adj(v)` using three orthogonal tricks:

1. **Reference compression.** For node `v`, pick a reference node `r` from the last `W` nodes (a small window). Encode `Adj(v)` as (a) a bit-mask saying which of `r`'s neighbors are kept, plus (b) the extra neighbors in `v` not in `r`. Web-like graphs have strong similarity, so this slashes the payload.
2. **Interval encoding.** Within the extra neighbors, find runs of consecutive IDs and encode each as `(start, length)`.
3. **Gap encoding with $\zeta$-codes.** The remaining residual neighbors, sorted, are encoded as gaps; `$\zeta_k$` codes are a universal code family tuned for the empirical gap distribution of web graphs.

Combined with **Layered Label Propagation** to renumber nodes (so similar nodes get nearby IDs), this hits ~2 bits/edge on web/wiki graphs.

**Zuckerli (Versari et al., Google 2020).** Same skeleton as BVGraph, but the gap encoder is replaced with **context-aware ANS (Asymmetric Numeral Systems)**. Instead of one global gap distribution, gaps are conditioned on local context (previous gap, node degree bucket), and ANS gives near-arithmetic-coding efficiency at much higher speed. Also adds a smarter reference selection that searches a wider window using LSH. Net effect: 20–30% smaller than BVGraph at comparable decode speed.

**WebGraph: The Next Generation (Boldi, Fontana, Vigna, WWW 2024).** Same compression format as BVGraph, but a clean-slate Rust implementation with zero-copy memory-mapped access, SIMD-accelerated decoding, and idiomatic Rust iterators. Decoding throughput is ~3× the Java version and memory footprint at load time is essentially the file size.

**Chu et al. (SIGMOD 2024): Graph Summarization: Compactness Meets Efficiency.** Lossy summarization where the graph is replaced by **supernodes** (groups of original nodes sharing structural roles) and **superedges** (aggregate edges between supernodes), with a small "correction" set of plus/minus edges to recover the original adjacency exactly (or approximately, under a tolerance). The contribution is an algorithm that:

- Picks merge candidates using a **min-hash signature** over neighborhoods (so candidate pairs are similar-neighbor pairs in near-constant time),
- Evaluates the **bit-cost delta** of each merge using an incremental MDL score,
- Greedily merges the best candidate, repeating until no merge reduces total cost.

Runs in near-linear time and produces summaries within a few percent of the optimal compactness on web-scale inputs.

**Poincaré Embeddings (Nickel & Kiela, NeurIPS 2017).** Embed each node `v` as a point `θ_v` in the open unit ball $\mathbb{D}^n$. Distance is the Poincaré metric

$$d(u,v) = \mathrm{arcosh}\!\left(1 + 2\frac{\|u-v\|^2}{(1-\|u\|^2)(1-\|v\|^2)}\right)$$

which blows up near the boundary, giving exponentially more "room" at large radius, the natural geometry of trees. Training minimizes a max-margin loss that pulls `is-a` neighbors close and pushes random non-neighbors apart, using **Riemannian SGD**: each gradient is rescaled by the local metric tensor and the update is reprojected back into the ball after each step. Children typically end up near the boundary; ancestors stay near the origin. In ~10–50 dimensions this preserves the WordNet/Wikipedia subsumption hierarchy with accuracy that needs hundreds of dimensions in Euclidean space.

---

## Why the Raw Category Graph Is Hard

The category links Wikipedians create encode multiple relations at once: `is-a`, `part-of`, `related-to`, `topic-of`, `instance-of`. The graph contains thousands of cycles (e.g. `Category:Cats` and `Category:Felines` can each reach the other), conflates instances with classes (`Category:Barack Obama` is a sibling of `Category:Presidents of the United States`), and mixes thematic groupings with strict subsumption (`Category:Cuisine of Japan` is not a kind of `Category:Japan`). Anyone who has tried to use the raw `skos:broader` edges from DBpedia knows this pain.

So the problem splits naturally:

1. **Construction**: extract a clean, typed, acyclic ontology from the raw category graph.
2. **Compression**: represent the resulting graph (which still has billions of edges once you include article membership) so that lookups, embeddings, and reasoning are fast.

---

## Graph Construction: From Soup to Ontology

### The Classical Pipeline (still a strong baseline)

The seminal work is Ponzetto and Strube's **WikiTaxonomy** (AAAI 2007, extended in AI Journal 2011). Their pipeline is the template most later systems follow:

1. **Lexico-syntactic parsing** of category names to detect head nouns (`Capitals in Europe` → head `Capitals`).
2. **Plural/singular matching** between child and parent heads to keep only likely `is-a` edges.
3. **WordNet grounding** to disambiguate and to filter relations that contradict known hypernymy.
4. **Cycle elimination** by minimum feedback arc set heuristics.

**YAGO** (Suchanek et al., extended through YAGO 4 and **YAGO 4.5**, arXiv 2023 / SIGIR 2024) keeps this skeleton but anchors every Wikipedia category in WordNet synsets and, more recently, in Schema.org's top-level ontology, giving you a logically consistent, OWL2-compliant taxonomy. YAGO 4.5 ships ~50M entities with strong axiomatization, and is the cleanest "drop-in" Wikipedia-derived taxonomy you can grab today.

**DBpedia** takes a different path: it maintains a hand-curated upper ontology (~700 classes) and uses community-built mappings from infoboxes to types. The category graph itself is exposed only as the noisy `skos:broader` relation. If you want types, use DBpedia; if you want a category taxonomy, do not stop here.

### The Modern SOTA: CaLiGraph

If you only look at one system, look at **CaLiGraph** (Heist & Paulheim, ISWC 2019 → Semantic Web Journal 2025). The 2025 release is the current state of the art for turning Wikipedia categories *and list pages* into a typed, axiomatized knowledge graph.

The pipeline:

- **Cat2Ax** (Heist & Paulheim, ISWC 2019) mines linguistic patterns over category names and then validates and weights them using statistics over the entities each category contains. For `Category:German jazz singers`, it learns that members should satisfy `type = Singer`, `genre = Jazz`, `nationality = German`. The key insight: category *names* alone are noisy, so the patterns mined from them are confirmed against the signal-rich set of entities each category groups.
- **List page exploitation**: Wikipedia list pages (`List of X`) are treated as first-class taxonomic evidence, dramatically expanding type coverage for long-tail entities.
- **Subsumption inference** combines lexical heuristics, axiom subsumption, and DBpedia/Wikidata grounding to produce a true DAG.
- **Embedding-based entity disambiguation** in the 2024+ releases uses transformer encoders to resolve the instance/class confusion.

The latest CaLiGraph release (v3.0, as reported on [caligraph.org](https://caligraph.org/statistics.html)) contains roughly **1.3M classes (1,285,189), ~15M entities (14,727,963), and tens of millions of relation assertions (~37M)**, with a stricter taxonomy than YAGO and far richer typing than DBpedia. The codebase is open at `github.com/nheist/CaLiGraph`.

### Where LLMs Are Moving the Needle

Recent work (2023–2025) has been replacing the rule-and-WordNet steps with LLM scoring:

| Approach | What changes |
|---|---|
| **TaxoExpan** (Shen et al., WWW 2020) | GNN over local ego-graphs to predict where a new node attaches. Self-supervised on existing taxonomies. Still a strong baseline for the *attachment* subproblem. |
| **HiExpan** (Shen et al., KDD 2018) | Tree-structured expansion guided by seed sets and weak supervision from raw text. |
| **TaxoEnrich / Musubu / Chain-of-Layer (2023–24)** | Use LLMs to score parent-child candidate pairs in zero/few-shot. Beats GNN-only methods on long-tail concepts, where embeddings are weak. |
| **LLM-as-verifier hybrids (2024–25)** | The current frontier: cheap retriever proposes candidate edges, LLM judges with `is-a` prompts and definitional context. Used to refine CaLiGraph and to bootstrap domain taxonomies. |

The pattern is consistent with what we see in scalable synthetic data generation: classical structure + LLM judgment is dominating pure-neural and pure-symbolic approaches.

---

## Graph Compression: Storing the Beast

Once you have a clean graph, you still need to fit it in memory or stream it at query time. Two distinct lines of work apply.

### Lossless Web-Graph Compression

**BVGraph / WebGraph** (Boldi & Vigna, WWW 2004) is still the workhorse and still close to SOTA for compressing very large adjacency lists. The trick: web-graph-like data (which includes Wikipedia link and category graphs) exhibits **locality** (numerically close node IDs tend to share neighbors) and **similarity** (nearby nodes have overlapping adjacency lists). BVGraph exploits both via:

- **Reference compression**: encode a node's adjacency list as a delta against a recent neighbor's list.
- **Gap encoding** with $\zeta$-codes for sorted differences.
- **Interval encoding** for runs of consecutive IDs.

On the Wikipedia link graph this reaches ~2 bits per edge, within a small constant of the information-theoretic lower bound for the structure class. The newer **Zuckerli** (Versari et al., 2020) and **WebGraph 4.x** improve this another 20–30% using better reorderings and entropy coders, and Rust ports (`webgraph-rs`) make it practical to load the full English Wikipedia link/category graph into a few hundred MB of RAM.

### Lossy Graph Summarization

If you can tolerate approximation, **graph summarization** collapses nodes into supernodes that share structural roles. The current SOTA reference is **"Graph Summarization: Compactness Meets Efficiency"** (Chu et al., SIGMOD 2024), which gives near-linear-time algorithms producing summaries within a few percent of the optimal compactness on web-scale graphs. For the Wikipedia category graph specifically, this is useful when you want a "zoomed-out" topical map for visualization or for use as a coarse routing structure in retrieval.

### Embedding-Based "Compression"

The third route: do not store the graph, store *vectors* that preserve it. Hyperbolic and box embeddings (Poincaré, Lorentz, Box4ET) compress hierarchical structure into 50–200 dimensions while preserving subsumption with surprising fidelity. For the Wikipedia category DAG, hyperbolic embeddings can answer `is-a` queries with high precision and a footprint orders of magnitude smaller than the explicit edge list. This is what powers retrieval over Wikipedia categories in many modern RAG systems.

---

## The Open Problems

A few things still are not solved:

1. **Multilingual category alignment.** Wikidata gives you cross-lingual entity links, but category structure diverges sharply across languages. There is no clean cross-lingual category ontology yet.
2. **Temporal categories.** Categories like `2024 in film` proliferate and decay; no current system handles time-indexed categories cleanly.
3. **Instance-class boundary at scale.** CaLiGraph handles the obvious cases; the long tail (especially in biology, chemistry, and geography) still leaks instances into the class hierarchy.
4. **End-to-end neural construction.** No purely neural system yet beats the classical pipeline + LLM-verifier hybrid. This may not change for a while; structured priors are doing real work.

The Wikipedia category graph remains the largest publicly available, broadly-domain ontological resource on the planet. Getting it into usable shape is still an active, surprisingly under-tooled area, and one of the highest-leverage substrates for the kind of "smart internet" search infrastructure we care about.
