import React from 'react';
import MDXComponents from '@theme/MDXComponents';
import CodeBlock from '@theme/CodeBlock';
import Admonition from '@theme/Admonition';
import {workspaceAssetHref, workspaceDocumentHref} from '@site/src/utils/documentUrls';

function childrenOf(node, context) {
  return (node.children || []).map((child, index) => (
    <SafeNode key={index} node={child} {...context} />
  ));
}

function sourceProps(node, documentPath, lineOffset = 0) {
  if (!documentPath || !node?.position?.startLine) return {};
  return {
    'data-context-file': documentPath,
    'data-context-start-line': node.position.startLine,
    'data-context-end-line': node.position.endLine || node.position.startLine,
    ...(lineOffset ? {'data-context-line-offset': lineOffset} : {}),
  };
}

function SafeNode({node, workspaceId, workspaceSlug, documentPath}) {
  if (!node || node.type === 'empty') return null;
  const context = {workspaceId, workspaceSlug, documentPath};
  const source = sourceProps(node, documentPath);

  switch (node.type) {
    case 'root': return <>{childrenOf(node, context)}</>;
    case 'text': return node.value;
    case 'paragraph': return <p {...source}>{childrenOf(node, context)}</p>;
    case 'heading': {
      const Heading = MDXComponents[`h${node.depth}`];
      return <Heading id={node.id} {...source}>{childrenOf(node, context)}</Heading>;
    }
    case 'emphasis': return <em {...source}>{childrenOf(node, context)}</em>;
    case 'strong': return <strong {...source}>{childrenOf(node, context)}</strong>;
    case 'delete': return <del {...source}>{childrenOf(node, context)}</del>;
    case 'blockquote': return <blockquote {...source}>{childrenOf(node, context)}</blockquote>;
    case 'thematicBreak': return <hr {...source} />;
    case 'break': return <br {...source} />;
    case 'inlineCode': return <MDXComponents.code {...source}>{node.value}</MDXComponents.code>;
    case 'code': return (
      <div {...sourceProps(node, documentPath, 1)} style={{display: 'contents'}}>
        <CodeBlock language={node.lang || undefined}>{node.value}</CodeBlock>
      </div>
    );
    case 'link': {
      const href = workspaceDocumentHref(node.url, workspaceSlug, documentPath);
      return <MDXComponents.a href={href} title={node.title || undefined} {...source}>{childrenOf(node, context)}</MDXComponents.a>;
    }
    case 'image': return (
      <MDXComponents.img
        src={workspaceAssetHref(node.url, workspaceId, documentPath)}
        alt={node.alt}
        title={node.title || undefined}
        {...source}
      />
    );
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul';
      const Component = node.ordered ? Tag : MDXComponents.ul;
      const containsTasks = (node.children || []).some(item => item.checked !== null);
      return (
        <Component
          start={node.ordered ? node.start : undefined}
          className={containsTasks ? 'contains-task-list' : undefined}
          {...source}
        >
          {childrenOf(node, context)}
        </Component>
      );
    }
    case 'listItem': {
      const ListItem = MDXComponents.li;
      return (
      <ListItem className={node.checked === null ? undefined : 'task-list-item'} {...source}>
        {node.checked === null ? null : <input type="checkbox" checked={node.checked} readOnly disabled />}
        {childrenOf(node, context)}
      </ListItem>
      );
    }
    case 'table': {
      const [head, ...body] = node.children || [];
      return (
        <table {...source}>
          {head ? <thead><SafeNode node={head} {...context} /></thead> : null}
          {body.length ? <tbody>{body.map((row, index) => <SafeNode key={index} node={row} {...context} />)}</tbody> : null}
        </table>
      );
    }
    case 'tableRow': return <tr {...source}>{childrenOf(node, context)}</tr>;
    case 'tableCell': {
      const Tag = node.header ? 'th' : 'td';
      return <Tag style={node.align ? {textAlign: node.align} : undefined} {...source}>{childrenOf(node, context)}</Tag>;
    }
    case 'math': {
      const Tag = node.display ? 'div' : 'span';
      return <Tag {...source} className={node.display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{__html: node.html}} />;
    }
    case 'admonition': return (
      <Admonition {...source} type={node.admonitionType} title={node.title || undefined}>
        {childrenOf(node, context)}
      </Admonition>
    );
    case 'element': return React.createElement(node.name, {...(node.props || {}), ...source}, childrenOf(node, context));
    case 'component': {
      const Component = MDXComponents[node.name];
      if (!Component) return null;
      return React.createElement(Component, node.props || {}, childrenOf(node, context));
    }
    default: return null;
  }
}

export default function SafeDocument({tree, workspaceId, workspaceSlug, documentPath}) {
  return <SafeNode node={tree} workspaceId={workspaceId} workspaceSlug={workspaceSlug} documentPath={documentPath} />;
}
