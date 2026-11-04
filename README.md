# Ground Notes

Read an article, mark what stood out and say why, then compare with another reader and ask them about it. A Future of the Web prototype for the week's theme, *belong*. The about page (`site/about.html`) explains the idea.

## Run it

    npm install
    netlify dev          # http://localhost:8888

Storage (Netlify Blobs) works locally with no account. Test data lands in `.netlify/`, which is git-ignored.

## The AI parts

Two features use Claude: rephrasing a question so it stays curious, and suggesting questions about two readings. They're off unless `ANTHROPIC_API_KEY` is set. Locally: `cp .env.example .env`, paste the key after the `=`, and restart `netlify dev`, which reads `.env` on start (`.env` is git-ignored). When deployed, set it in the site's Netlify environment settings. Without it, both use ready-made questions and everything else works the same. Set `GROUND_NOTES_MODEL` to use a different model; the default is `claude-opus-5-5` at low effort.

## Layout

    site/                     the pages: index, read, about; css/ and js/
    netlify/functions/api.mjs the one server function
    netlify/lib/extract.mjs   page → clean article (Readability)
    netlify/lib/llm.mjs       the two AI helpers and their fallbacks
    netlify/lib/seeds.json    sample readers for the three starter articles
    tools/                    scripts for checking extraction and writing seeds
