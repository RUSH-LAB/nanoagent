# Write Documentation

## Setup

### Installing Node.js

Install [Homebrew](https://brew.sh/) if you do not have it.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Make sure you followed the instructions to add Homebrew to your `PATH`. Suppose your username is `zy45` and you are using a Mac, then these commands will appear in the terminal after installing Homebrew:

```bash
echo >> /Users/zy45/.zprofile
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> /Users/zy45/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Then use Homebrew to install Node.js.

```bash
brew install node
```

### Installing Docusaurus

Run this command to create a new Docusaurus site. **DO NOT RUN IF YOU ALREADY HAVE IT**.

```bash
npm init docusaurus@latest
```

I created one named `mochi-ai` with JavaScript. You can go to the `mochi-ai` directory, build the website, and start the development server, and then open `http://localhost:3000` in your browser to see the website.

```bash
cd mochi-ai
npm run build
npm run serve
```

```bash
npm install remark-math rehype-katex @mdx-js/mdx katex
npm install @easyops-cn/docusaurus-search-local
```
