import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

// server/routes/misc-tools.js is CommonJS; load the REAL module via createRequire the
// way the sibling route suites do (tests/next-misc-filequality-cache.test.mjs). These
// tests pin the exact CURRENT output of GET /api/file/quality: the word / structure /
// heading / citation / media / readability scoring ladders, the level classification
// (excellent through minimal), and every suggestion string. The goldens below were
// captured from the real handler; no source file is touched.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

// Fixture builders (deterministic, so the captured goldens can never drift).
// A backtick without writing one literally (keeps this file free of code fences).
const TICK = String.fromCharCode(96);
// A sentence of k words: k copies of "word" joined by spaces with a trailing period,
// so it tokenizes to exactly k whitespace words and reads as one k-word sentence.
const sentence = (k) => Array(k).fill('word').join(' ') + '.';
// A body of n such sentences: exactly n*k words and an average sentence length of k,
// which is what drives the handler's readability tier.
const body = (n, k) => Array(n).fill(sentence(k)).join(' ');
// Citations / images / code fences, shaped to match the handler's own regexes.
const cites = (c) => Array.from({length: c}, (_, i) => '[@ref' + i + ']').join(' ');
const imgs = (m) => Array.from({length: m}, (_, i) => '![alt](img' + i + '.png)').join('\n');
const code = (c) => Array.from({length: c}, (_, i) => TICK + TICK + TICK + '\ncode ' + i + '\n' + TICK + TICK + TICK).join('\n');

const FM_FULL = '---\ntitle: Sample\ndate: 2026-01-01\n---\n';
const FM_TITLE = '---\ntitle: Sample\n---\n';
const FM_DATE = '---\ndate: 2026-01-01\n---\n';
const FM_NEITHER = '---\nsummary: a short note\n---\n';

const HEADINGS_5 = '# Title H1\n## Sub H2 A\n## Sub H2 B\n### Sub H3 A\n### Sub H3 B';
const HEADINGS_3 = '# Title H1\n## Sub H2 A\n### Sub H3 A';
const HEADINGS_2 = '# Title H1\n## Sub H2 A';
const HEADINGS_1 = '# Title H1';

// A body whose period-delimited segments are all 5 chars or fewer, so the handler
// counts zero sentences (the readability zero-sentence arm).
const READ0 = 'ab. cd. ef. gh. ij. kl.';

const FIXTURES = [
  // Word-count ladder: pure body, no frontmatter / headings / citations / media.
  { name: 'words_1000', rel: 'content/quality/words_1000.md', content: body(100, 10) + '\n' },
  { name: 'words_500',  rel: 'content/quality/words_500.md',  content: body(50, 10) + '\n' },
  { name: 'words_200',  rel: 'content/quality/words_200.md',  content: body(20, 10) + '\n' },
  { name: 'words_100',  rel: 'content/quality/words_100.md',  content: body(10, 10) + '\n' },
  { name: 'words_50',   rel: 'content/quality/words_50.md',   content: body(5, 10) + '\n' },

  // Frontmatter field detection (small body so the other dimensions stay constant).
  { name: 'fm_title_only', rel: 'content/quality/fm_title_only.md', content: FM_TITLE + body(5, 10) + '\n' },
  { name: 'fm_date_only',  rel: 'content/quality/fm_date_only.md',  content: FM_DATE + body(5, 10) + '\n' },
  { name: 'fm_neither',    rel: 'content/quality/fm_neither.md',    content: FM_NEITHER + body(5, 10) + '\n' },

  // Heading ladder (full frontmatter + a 500-word body so words is fixed at 20).
  { name: 'hd_5',        rel: 'content/quality/hd_5.md',        content: FM_FULL + HEADINGS_5 + '\n\n' + body(50, 10) + '\n' },
  { name: 'hd_3',        rel: 'content/quality/hd_3.md',        content: FM_FULL + HEADINGS_3 + '\n\n' + body(50, 10) + '\n' },
  { name: 'hd_2_multi',  rel: 'content/quality/hd_2_multi.md',  content: FM_FULL + HEADINGS_2 + '\n\n' + body(50, 10) + '\n' },
  { name: 'hd_1_h1only', rel: 'content/quality/hd_1_h1only.md', content: FM_FULL + HEADINGS_1 + '\n\n' + body(50, 10) + '\n' },

  // Citations: partial (min formula) and capped.
  { name: 'cit_partial', rel: 'content/quality/cit_partial.md', content: FM_FULL + body(50, 10) + '\n' + cites(3) + '\n' },
  { name: 'cit_cap',     rel: 'content/quality/cit_cap.md',     content: FM_FULL + body(50, 10) + '\n' + cites(6) + '\n' },

  // Media: image points, image cap, code-block contribution, and the code suggestion.
  { name: 'media_img_partial',  rel: 'content/quality/media_img_partial.md',  content: FM_FULL + body(50, 10) + '\n' + imgs(2) + '\n' },
  { name: 'media_img_cap',      rel: 'content/quality/media_img_cap.md',      content: FM_FULL + body(50, 10) + '\n' + imgs(4) + '\n' },
  { name: 'media_code_contrib', rel: 'content/quality/media_code_contrib.md', content: FM_FULL + body(50, 10) + '\n' + imgs(1) + '\n' + code(2) + '\n' },
  { name: 'code_suggest',       rel: 'content/quality/code_suggest.md',       content: FM_FULL + body(50, 10) + ' algorithm.\n' },

  // Readability ladder (full frontmatter + a body of controlled sentence length).
  { name: 'read_8', rel: 'content/quality/read_8.md', content: FM_FULL + body(30, 18) + '\n' },
  { name: 'read_5', rel: 'content/quality/read_5.md', content: FM_FULL + body(24, 23) + '\n' },
  { name: 'read_2', rel: 'content/quality/read_2.md', content: FM_FULL + body(20, 30) + '\n' },
  { name: 'read_0', rel: 'content/quality/read_0.md', content: FM_FULL + READ0 + '\n' },

  // Everything high: the excellent level and the empty-suggestions case.
  { name: 'excellent_max', rel: 'content/quality/excellent_max.md',
    content: FM_FULL + HEADINGS_5 + '\n\n' + body(100, 10) + '\n' + cites(6) + '\n' + imgs(4) + '\n' + code(2) + '\n' },

  // Boundary-tightening fixtures: pin the LOW side of cutoffs that the adjacent
  // fixtures leave loose, using just-below-threshold values.
  // 999 words is one short of the 1000 cutoff, so words still scores 20 (not 25).
  { name: 'words_999', rel: 'content/quality/words_999.md', content: body(99, 10) + ' ' + sentence(9) + '\n' },
  // Score exactly 80 (25+15+20+0+10+10): the inclusive edge of the excellent level.
  { name: 'excellent_min', rel: 'content/quality/excellent_min.md',
    content: FM_FULL + HEADINGS_5 + '\n\n' + body(100, 10) + '\n' + imgs(4) + '\n' },
  // Score exactly 79 (one image fewer, media 9): just below the excellent cutoff, so good.
  { name: 'good_max', rel: 'content/quality/good_max.md',
    content: FM_FULL + HEADINGS_5 + '\n\n' + body(100, 10) + '\n' + imgs(3) + '\n' },
  // Average sentence length exactly 15: the inclusive top edge of the readability ladder.
  { name: 'read_15', rel: 'content/quality/read_15.md', content: FM_FULL + body(34, 15) + '\n' },
  // Three code fences, no images: media = min(10, min(5, 3*2)) = 5, pinning the code cap of 5.
  { name: 'media_code_cap', rel: 'content/quality/media_code_cap.md', content: FM_FULL + body(50, 10) + '\n' + code(3) + '\n' },
];

const GOLDENS = {
  "words_1000": {
    "path": "content/quality/words_1000.md",
    "score": 35,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 25,
        "max": 25,
        "wordCount": 1000
      },
      "structure": {
        "score": 0,
        "max": 35,
        "frontmatter": 0,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 100
      }
    },
    "suggestions": [
      "Add YAML frontmatter with title and date fields",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "words_500": {
    "path": "content/quality/words_500.md",
    "score": 30,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 500
      },
      "structure": {
        "score": 0,
        "max": 35,
        "frontmatter": 0,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add YAML frontmatter with title and date fields",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "words_200": {
    "path": "content/quality/words_200.md",
    "score": 25,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 15,
        "max": 25,
        "wordCount": 200
      },
      "structure": {
        "score": 0,
        "max": 35,
        "frontmatter": 0,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 20
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add YAML frontmatter with title and date fields",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "words_100": {
    "path": "content/quality/words_100.md",
    "score": 20,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 10,
        "max": 25,
        "wordCount": 100
      },
      "structure": {
        "score": 0,
        "max": 35,
        "frontmatter": 0,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 10
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add YAML frontmatter with title and date fields",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "words_50": {
    "path": "content/quality/words_50.md",
    "score": 15,
    "level": "minimal",
    "breakdown": {
      "words": {
        "score": 5,
        "max": 25,
        "wordCount": 50
      },
      "structure": {
        "score": 0,
        "max": 35,
        "frontmatter": 0,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 5
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add YAML frontmatter with title and date fields",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "fm_title_only": {
    "path": "content/quality/fm_title_only.md",
    "score": 25,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 5,
        "max": 25,
        "wordCount": 50
      },
      "structure": {
        "score": 10,
        "max": 35,
        "frontmatter": 10,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 5
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add a date field to frontmatter",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "fm_date_only": {
    "path": "content/quality/fm_date_only.md",
    "score": 25,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 5,
        "max": 25,
        "wordCount": 50
      },
      "structure": {
        "score": 10,
        "max": 35,
        "frontmatter": 10,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 5
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add a title field to frontmatter",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "fm_neither": {
    "path": "content/quality/fm_neither.md",
    "score": 20,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 5,
        "max": 25,
        "wordCount": 50
      },
      "structure": {
        "score": 5,
        "max": 35,
        "frontmatter": 5,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 5
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add a title field to frontmatter",
      "Add a date field to frontmatter",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "hd_5": {
    "path": "content/quality/hd_5.md",
    "score": 65,
    "level": "good",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 519
      },
      "structure": {
        "score": 35,
        "max": 35,
        "frontmatter": 15,
        "headings": 20,
        "headingCounts": {
          "h1": 1,
          "h2": 2,
          "h3": 2
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.4,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "hd_3": {
    "path": "content/quality/hd_3.md",
    "score": 60,
    "level": "good",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 511
      },
      "structure": {
        "score": 30,
        "max": 35,
        "frontmatter": 15,
        "headings": 15,
        "headingCounts": {
          "h1": 1,
          "h2": 1,
          "h3": 1
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.2,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "hd_2_multi": {
    "path": "content/quality/hd_2_multi.md",
    "score": 55,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 507
      },
      "structure": {
        "score": 25,
        "max": 35,
        "frontmatter": 15,
        "headings": 10,
        "headingCounts": {
          "h1": 1,
          "h2": 1,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.1,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "hd_1_h1only": {
    "path": "content/quality/hd_1_h1only.md",
    "score": 55,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 503
      },
      "structure": {
        "score": 25,
        "max": 35,
        "frontmatter": 15,
        "headings": 10,
        "headingCounts": {
          "h1": 1,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.1,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add sub-headings (##, ###) for better structure",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "cit_partial": {
    "path": "content/quality/cit_partial.md",
    "score": 51,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 503
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 6,
        "max": 10,
        "count": 3
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 9.9,
        "sentenceCount": 51
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add images to enhance visual engagement"
    ]
  },
  "cit_cap": {
    "path": "content/quality/cit_cap.md",
    "score": 55,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 506
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 10,
        "max": 10,
        "count": 6
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 9.9,
        "sentenceCount": 51
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add images to enhance visual engagement"
    ]
  },
  "media_img_partial": {
    "path": "content/quality/media_img_partial.md",
    "score": 51,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 500
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 6,
        "max": 10,
        "images": 2,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources"
    ]
  },
  "media_img_cap": {
    "path": "content/quality/media_img_cap.md",
    "score": 55,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 500
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 10,
        "max": 10,
        "images": 4,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources"
    ]
  },
  "media_code_contrib": {
    "path": "content/quality/media_code_contrib.md",
    "score": 52,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 500
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 7,
        "max": 10,
        "images": 1,
        "codeBlocks": 2
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources"
    ]
  },
  "code_suggest": {
    "path": "content/quality/code_suggest.md",
    "score": 45,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 501
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 9.8,
        "sentenceCount": 51
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement",
      "Add code blocks to illustrate technical concepts"
    ]
  },
  "read_8": {
    "path": "content/quality/read_8.md",
    "score": 43,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 540
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 8,
        "max": 10,
        "avgSentenceLength": 18,
        "sentenceCount": 30
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "read_5": {
    "path": "content/quality/read_5.md",
    "score": 40,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 552
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 5,
        "max": 10,
        "avgSentenceLength": 23,
        "sentenceCount": 24
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "read_2": {
    "path": "content/quality/read_2.md",
    "score": 37,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 600
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 2,
        "max": 10,
        "avgSentenceLength": 30,
        "sentenceCount": 20
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement",
      "Shorten sentences for better readability — aim for 15-20 words per sentence"
    ]
  },
  "read_0": {
    "path": "content/quality/read_0.md",
    "score": 20,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 5,
        "max": 25,
        "wordCount": 6
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 0,
        "max": 10,
        "avgSentenceLength": 0,
        "sentenceCount": 0
      }
    },
    "suggestions": [
      "Add more content — aim for at least 500 words for a substantive document",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "excellent_max": {
    "path": "content/quality/excellent_max.md",
    "score": 90,
    "level": "excellent",
    "breakdown": {
      "words": {
        "score": 25,
        "max": 25,
        "wordCount": 1025
      },
      "structure": {
        "score": 35,
        "max": 35,
        "frontmatter": 15,
        "headings": 20,
        "headingCounts": {
          "h1": 1,
          "h2": 2,
          "h3": 2
        }
      },
      "citations": {
        "score": 10,
        "max": 10,
        "count": 6
      },
      "media": {
        "score": 10,
        "max": 10,
        "images": 4,
        "codeBlocks": 2
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.1,
        "sentenceCount": 101
      }
    },
    "suggestions": []
  },
  "words_999": {
    "path": "content/quality/words_999.md",
    "score": 30,
    "level": "needs-improvement",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 999
      },
      "structure": {
        "score": 0,
        "max": 35,
        "frontmatter": 0,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 100
      }
    },
    "suggestions": [
      "Add YAML frontmatter with title and date fields",
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "excellent_min": {
    "path": "content/quality/excellent_min.md",
    "score": 80,
    "level": "excellent",
    "breakdown": {
      "words": {
        "score": 25,
        "max": 25,
        "wordCount": 1019
      },
      "structure": {
        "score": 35,
        "max": 35,
        "frontmatter": 15,
        "headings": 20,
        "headingCounts": {
          "h1": 1,
          "h2": 2,
          "h3": 2
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 10,
        "max": 10,
        "images": 4,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.2,
        "sentenceCount": 100
      }
    },
    "suggestions": [
      "Add citations [@key] to reference sources"
    ]
  },
  "good_max": {
    "path": "content/quality/good_max.md",
    "score": 79,
    "level": "good",
    "breakdown": {
      "words": {
        "score": 25,
        "max": 25,
        "wordCount": 1019
      },
      "structure": {
        "score": 35,
        "max": 35,
        "frontmatter": 15,
        "headings": 20,
        "headingCounts": {
          "h1": 1,
          "h2": 2,
          "h3": 2
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 9,
        "max": 10,
        "images": 3,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10.2,
        "sentenceCount": 100
      }
    },
    "suggestions": [
      "Add citations [@key] to reference sources"
    ]
  },
  "read_15": {
    "path": "content/quality/read_15.md",
    "score": 45,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 510
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 0,
        "max": 10,
        "images": 0,
        "codeBlocks": 0
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 15,
        "sentenceCount": 34
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  },
  "media_code_cap": {
    "path": "content/quality/media_code_cap.md",
    "score": 50,
    "level": "adequate",
    "breakdown": {
      "words": {
        "score": 20,
        "max": 25,
        "wordCount": 500
      },
      "structure": {
        "score": 15,
        "max": 35,
        "frontmatter": 15,
        "headings": 0,
        "headingCounts": {
          "h1": 0,
          "h2": 0,
          "h3": 0
        }
      },
      "citations": {
        "score": 0,
        "max": 10,
        "count": 0
      },
      "media": {
        "score": 5,
        "max": 10,
        "images": 0,
        "codeBlocks": 3
      },
      "readability": {
        "score": 10,
        "max": 10,
        "avgSentenceLength": 10,
        "sentenceCount": 50
      }
    },
    "suggestions": [
      "Add headings (##, ###) to organize content",
      "Add citations [@key] to reference sources",
      "Add images to enhance visual engagement"
    ]
  }
};

describe('GET /api/file/quality (scoring tiers, level, suggestions characterization)', () => {
  // The handler reads exactly one file via fs.readFileSync(path.join(PROJECT_ROOT,
  // filePath)); PROJECT_ROOT is a real mkdtemp dir (unique, isolated) and the read is
  // served from an in-memory map keyed by that absolute path, so the suite is hermetic.
  let ROOT;
  before(() => { ROOT = mkdtempSync(path.join(os.tmpdir(), 'filequality-tiers-')); });
  after(() => { rmSync(ROOT, { recursive: true, force: true }); });

  // Drive the real handler with a pass-through cached (the exact pre-cache code path),
  // an fs whose readFileSync is keyed by the one absolute path, isValidFilePath true,
  // and a captured json().
  async function invoke(rel, content) {
    const abs = path.join(ROOT, rel);
    const fs = {
      readFileSync(fp) {
        if (fp === abs) return content;
        const e = new Error('ENOENT: ' + fp); e.code = 'ENOENT'; throw e;
      },
    };
    const url = new URL('http://localhost/api/file/quality?path=' + encodeURIComponent(rel));
    const req = { method: 'GET' };
    const res = { writableEnded: false };
    let captured = null;
    const ctx = {
      fs, path, PROJECT_ROOT: ROOT, isValidFilePath: () => true,
      cached: (_k, _t, fn) => fn(),
      json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    };
    await routes(req, res, url, '/api/file/quality', ctx);
    return captured;
  }

  // Each fixture pins the full payload (path, score, level, breakdown, suggestions)
  // against its captured golden.
  for (const fx of FIXTURES) {
    it('pins the full quality payload for ' + fx.name, async () => {
      const r = await invoke(fx.rel, fx.content);
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, GOLDENS[fx.name]);
      assert.equal(r.payload.path, fx.rel);
    });
  }

  // Self-consistency guard on the GOLDENS table: the captured goldens must span every
  // arm of every ladder, every level, and every suggestion, so the table cannot
  // silently shrink to a vacuous subset. Live-behavior pinning is done entirely by the
  // per-fixture deepEqual loop above; this test asserts properties of GOLDENS itself.
  it('collectively exercise every tier, level, and suggestion', () => {
    const g = Object.values(GOLDENS);
    const nums = (sel) => [...new Set(g.map(sel))].sort((a, b) => a - b);
    assert.deepEqual(nums(x => x.breakdown.words.score), [5, 10, 15, 20, 25]);
    assert.deepEqual(nums(x => x.breakdown.structure.frontmatter), [0, 5, 10, 15]);
    assert.deepEqual(nums(x => x.breakdown.structure.headings), [0, 10, 15, 20]);
    assert.deepEqual(nums(x => x.breakdown.readability.score), [0, 2, 5, 8, 10]);
    const cit = new Set(g.map(x => x.breakdown.citations.score));
    assert.ok(cit.has(0) && cit.has(10) && [...cit].some(s => s > 0 && s < 10), 'citation tiers');
    const media = new Set(g.map(x => x.breakdown.media.score));
    assert.ok(media.has(0) && media.has(10) && [...media].some(s => s > 0 && s < 10), 'media tiers');
    assert.deepEqual([...new Set(g.map(x => x.level))].sort(),
      ['adequate', 'excellent', 'good', 'minimal', 'needs-improvement']);
    // Full suggestion strings (including the em dash variants) are pinned by the
    // per-fixture deepEqual above; here we assert each distinct suggestion appears at
    // least once, matched by an ASCII prefix.
    const union = new Set(g.flatMap(x => x.suggestions));
    const has = (sub) => [...union].some(s => s.includes(sub));
    for (const sub of ['Add more content', 'Add a title field', 'Add a date field',
      'Add YAML frontmatter', 'Add headings', 'Add sub-headings', 'Add citations',
      'Add images', 'Add code blocks', 'Shorten sentences']) {
      assert.ok(has(sub), 'missing suggestion: ' + sub);
    }
    assert.ok(g.some(x => x.suggestions.length === 0), 'an all-satisfied fixture pins empty suggestions');
  });
});
