# Mochi Lab

A research and knowledge-sharing site built with [Docusaurus](https://docusaurus.io/) and deployed on [Vercel](https://vercel.com/). Authentication is handled by [Clerk](https://clerk.com/).

## Setup

```bash
npm install
```

## Development

```bash
npm start
```

Starts a local dev server at `http://localhost:3000`. Changes are reflected live.

## Build

```bash
npm run build
```

Generates static content into the `build` directory.

## Deployment

Deployed automatically via Vercel on push. Make sure your Vercel project has the Clerk environment variables configured and your domain is added in the Clerk Dashboard.

## Authentication

Clerk handles client-side authentication. Unauthenticated users see a sign-in widget; authenticated users see the site content. Configuration is in `src/theme/Root.js`.
