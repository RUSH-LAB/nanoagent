import React from 'react';
import Head from '@docusaurus/Head';
import {useBlogPost} from '@docusaurus/plugin-content-blog/client';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

function fallbackStructuredData(content, siteConfig) {
  const {metadata, assets, frontMatter} = content;
  const image = assets.image ?? frontMatter.image;
  const url = `${siteConfig.url}${metadata.permalink}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': url,
    mainEntityOfPage: url,
    url,
    headline: metadata.title,
    name: metadata.title,
    description: metadata.description,
    datePublished: metadata.date,
    author: metadata.authors.map(author => ({
      '@type': 'Person',
      ...(author.name ? {name: author.name} : {}),
      ...(author.title ? {description: author.title} : {}),
      ...(author.url ? {url: author.url} : {}),
      ...(author.imageURL ? {image: author.imageURL} : {}),
    })),
    ...(image ? {image} : {}),
  };
}

export default function RuntimeCompatibleBlogPostStructuredData() {
  const content = useBlogPost();
  const {siteConfig} = useDocusaurusContext();
  const structuredData = fallbackStructuredData(content, siteConfig);
  return <Head><script type="application/ld+json">{JSON.stringify(structuredData)}</script></Head>;
}
