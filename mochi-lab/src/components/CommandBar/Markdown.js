import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Highlight, Prism} from 'prism-react-renderer';
import {parseMarkdown, settledLength} from '@site/src/utils/markdown';
import {clientPlatform} from '@site/src/platform/client';
import styles from './assistant.module.css';

/**
 * The assistant's reply, rendered as elements.
 *
 * The model answers in markdown, and a chat window that prints it raw makes the
 * reader parse asterisks and backticks by eye. This component walks the block
 * tree from src/utils/markdown.js and builds React elements from it, so a
 * heading is a heading and a fenced block is a code box with a copy button.
 *
 * Nothing here injects HTML. There is no dangerouslySetInnerHTML, no
 * innerHTML, and no path by which a string in the reply becomes markup: every
 * piece of text ends up as a React child, which React escapes. A link is only
 * an anchor when the parser kept its href, and the parser only keeps http,
 * https, mailto and site relative hrefs. That is what makes it safe to render
 * text this component did not write.
 *
 * This component is mounted inside the CLI, which lives under Root and outside
 * LayoutProvider, so it must not use useColorMode or any other layout hook.
 * Light and dark are handled entirely in CSS, including the code colours, which
 * is why the Prism theme below is written in custom properties rather than in
 * literal colours.
 */

/* How long the copy button stays acknowledged before it offers itself again. */
const COPIED_MS = 1400;

/* Prism themes are inline styles, and an inline style cannot follow the site's
   colour mode on its own. Handing Prism custom properties instead pushes the
   choice back into assistant.module.css, where [data-theme='dark'] can answer
   it. The token names are Prism's own, plus lean4's `tactic` from
   src/client/prism-lean4.js. */
const TOKEN_THEME = {
  plain: {},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: 'var(--cli-code-comment)'}},
    {types: ['keyword', 'tactic', 'atrule', 'boolean', 'constant', 'symbol', 'important'],
      style: {color: 'var(--cli-code-keyword)'}},
    {types: ['string', 'char', 'attr-value', 'regex', 'url'], style: {color: 'var(--cli-code-string)'}},
    {types: ['number', 'builtin', 'class-name'], style: {color: 'var(--cli-code-number)'}},
    {types: ['function', 'tag', 'attr-name', 'selector'], style: {color: 'var(--cli-code-function)'}},
    {types: ['operator', 'punctuation'], style: {color: 'var(--cli-code-punctuation)'}},
  ],
};

/**
 * Is this language one Prism actually knows?
 *
 * The lookup is guarded with hasOwnProperty because the language comes from the
 * model: `constructor` would otherwise resolve through Object.prototype and
 * hand Prism a function where it expects a grammar.
 */
function grammarFor(lang) {
  if (!lang || !Object.prototype.hasOwnProperty.call(Prism.languages, lang)) return null;
  const grammar = Prism.languages[lang];
  return typeof grammar === 'object' && grammar !== null ? grammar : null;
}

/* ── Inline ─────────────────────────────────────────── */

function Spans({spans}) {
  return (
    <>
      {spans.map((span, i) => {
        // The index is a safe key: a span list is rebuilt whole on every parse
        // and never reordered in place.
        const key = i;
        if (span.type === 'code') return <code key={key} className={styles.inlineCode}>{span.text}</code>;
        if (span.type === 'strong') return <strong key={key}>{span.text}</strong>;
        if (span.type === 'em') return <em key={key}>{span.text}</em>;
        if (span.type === 'link') {
          // An off site link opens in a new tab so the reader does not lose the
          // page the CLI is docked to. A site path stays in this tab, as a plain
          // anchor: the CLI is mounted above the router, so it has no history to
          // push onto and a full navigation is the honest thing to do.
          const offSite = !span.href.startsWith('/');
          return (
            <a
              key={key}
              className={styles.link}
              href={span.href}
              {...(offSite ? {target: '_blank', rel: 'noreferrer noopener'} : null)}
            >
              {span.text || span.href}
            </a>
          );
        }
        return <React.Fragment key={key}>{span.text}</React.Fragment>;
      })}
    </>
  );
}

/* ── Fenced code ────────────────────────────────────── */

/**
 * A fenced block, with the one affordance a code box in a chat window needs.
 *
 * Copying is the reason a reply gets fenced in the first place, and selecting
 * text inside a scrolling strip that is three lines tall is miserable, so the
 * button is not decoration. A refused clipboard says so rather than pretending
 * it worked.
 */
function CodeBlock({lang, code}) {
  const [status, setStatus] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    let next = 'copied';
    try {
      await clientPlatform.clipboard.writeText(code);
    } catch {
      next = 'failed';
    }
    setStatus(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), COPIED_MS);
  }, [code]);

  const grammar = grammarFor(lang);
  const label = status === 'failed' ? 'copy failed' : status === 'copied' ? 'copied' : 'copy';

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang || 'text'}</span>
        <button
          type="button"
          className={styles.copy}
          onClick={copy}
          aria-label={`Copy this ${lang || 'code'} block`}
        >
          {label}
        </button>
      </div>
      {grammar ? (
        <Highlight theme={TOKEN_THEME} code={code} language={lang}>
          {({tokens, getLineProps, getTokenProps}) => (
            <pre className={styles.pre}>
              {tokens.map((line, li) => (
                <span key={li} {...getLineProps({line})}>
                  {line.map((token, ti) => <span key={ti} {...getTokenProps({token})} />)}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </Highlight>
      ) : (
        <pre className={styles.pre}>{code}</pre>
      )}
    </div>
  );
}

/* ── Blocks ─────────────────────────────────────────── */

function Block({block}) {
  switch (block.type) {
    case 'heading':
      // A heading element would join the page's outline, and the assistant's
      // idea of a first level heading is not the page's. The role carries the
      // same meaning to a screen reader without claiming a place in the
      // document structure.
      return (
        <div className={styles.heading} role="heading" aria-level={block.level} data-level={block.level}>
          <Spans spans={block.spans} />
        </div>
      );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List className={styles.list}>
          {block.items.map((item, i) => (
            <li key={i} className={styles.item}><Spans spans={item} /></li>
          ))}
        </List>
      );
    }
    case 'code':
      return <CodeBlock lang={block.lang} code={block.code} />;
    case 'quote':
      return <blockquote className={styles.quote}><Spans spans={block.spans} /></blockquote>;
    case 'rule':
      return <hr className={styles.rule} />;
    default:
      return <p className={styles.paragraph}><Spans spans={block.spans} /></p>;
  }
}

/**
 * The blocks of a reply, parsed as it arrives rather than once per delta.
 *
 * A streamed answer re-renders on every token, and memoising on the whole text
 * never hits while that text is still growing, so the opening paragraphs used
 * to be parsed again for every token that followed them. The parser can say
 * how much of a reply is already decided, and that head only ever grows, so
 * each settled paragraph is parsed exactly once here and only the tail still
 * being written is parsed again.
 *
 * The cache lives in a ref because it has to outlive a render, but it is a
 * cache and nothing else: the value returned is always parseMarkdown(source),
 * and a source that is not an extension of the cached head is simply parsed
 * whole again. That is also what happens whenever the parser cannot prove any
 * head has settled, so the slowest path here is the behaviour this replaced.
 */
function useBlocks(source) {
  const cache = useRef({settled: '', blocks: []});
  return useMemo(() => {
    const settled = source.slice(0, settledLength(source));
    const held = cache.current;
    const blocks = settled.startsWith(held.settled)
      ? held.blocks.concat(parseMarkdown(settled.slice(held.settled.length)))
      : parseMarkdown(settled);
    cache.current = {settled, blocks};
    // One list rather than a settled list beside a growing one, so a block
    // keeps its key when it crosses from the tail into the head and the copy
    // button of a code box is not reset underneath the reader.
    return blocks.concat(parseMarkdown(source.slice(settled.length)));
  }, [source]);
}

export default function Markdown({text}) {
  const blocks = useBlocks(typeof text === 'string' ? text : '');

  return (
    <div className={styles.markdown}>
      {blocks.map((block, i) => <Block key={i} block={block} />)}
    </div>
  );
}
