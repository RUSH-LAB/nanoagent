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

function SafeNode({node, workspaceId, workspaceSlug, documentPath}) {
  if (!node || node.type === 'empty') return null;
  const context = {workspaceId, workspaceSlug, documentPath};

  switch (node.type) {
    case 'root': return <>{childrenOf(node, context)}</>;
    case 'text': return node.value;
    case 'paragraph': return <p>{childrenOf(node, context)}</p>;
    case 'heading': {
      const Heading = MDXComponents[`h${node.depth}`];
      return <Heading id={node.id}>{childrenOf(node, context)}</Heading>;
    }
    case 'emphasis': return <em>{childrenOf(node, context)}</em>;
    case 'strong': return <strong>{childrenOf(node, context)}</strong>;
    case 'delete': return <del>{childrenOf(node, context)}</del>;
    case 'blockquote': return <blockquote>{childrenOf(node, context)}</blockquote>;
    case 'thematicBreak': return <hr />;
    case 'break': return <br />;
    case 'inlineCode': return <MDXComponents.code>{node.value}</MDXComponents.code>;
    case 'code': return <CodeBlock language={node.lang || undefined}>{node.value}</CodeBlock>;
    case 'link': {
      const href = workspaceDocumentHref(node.url, workspaceSlug, documentPath);
      return <MDXComponents.a href={href} title={node.title || undefined}>{childrenOf(node, context)}</MDXComponents.a>;
    }
    case 'image': return (
      <MDXComponents.img
        src={workspaceAssetHref(node.url, workspaceId, documentPath)}
        alt={node.alt}
        title={node.title || undefined}
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
        >
          {childrenOf(node, context)}
        </Component>
      );
    }
    case 'listItem': {
      const ListItem = MDXComponents.li;
      return (
      <ListItem className={node.checked === null ? undefined : 'task-list-item'}>
        {node.checked === null ? null : <input type="checkbox" checked={node.checked} readOnly disabled />}
        {childrenOf(node, context)}
      </ListItem>
      );
    }
    case 'table': {
      const [head, ...body] = node.children || [];
      return (
        <table>
          {head ? <thead><SafeNode node={head} {...context} /></thead> : null}
          {body.length ? <tbody>{body.map((row, index) => <SafeNode key={index} node={row} {...context} />)}</tbody> : null}
        </table>
      );
    }
    case 'tableRow': return <tr>{childrenOf(node, context)}</tr>;
    case 'tableCell': {
      const Tag = node.header ? 'th' : 'td';
      return <Tag style={node.align ? {textAlign: node.align} : undefined}>{childrenOf(node, context)}</Tag>;
    }
    case 'math': {
      const Tag = node.display ? 'div' : 'span';
      return <Tag className={node.display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{__html: node.html}} />;
    }
    case 'admonition': return (
      <Admonition type={node.admonitionType} title={node.title || undefined}>
        {childrenOf(node, context)}
      </Admonition>
    );
    case 'element': return React.createElement(node.name, node.props || {}, childrenOf(node, context));
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
