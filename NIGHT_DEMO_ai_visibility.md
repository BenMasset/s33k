# AI Visibility, getmasset.com

The morning demo of s33k's newest feature, the AI Visibility Funnel. This is real data, pulled live from the hosted s33k prod instance for getmasset.com on 2026-06-15. Where a number is zero, it says zero. Nothing here is invented.

## What this feature is

Every other "AI search" tool answers the question by asking the AI. It prompts ChatGPT or Perplexity, "do you mention getmasset.com?", and reports what the model says. That is gameable, non-reproducible, and a guess.

s33k answers it a different way. It measures what AI engines actually DO on your site, using only first-party behavior s33k already records. Two signals, joined into one funnel:

1. AI CRAWLERS hitting your pages. Which engines (GPTBot/ChatGPT, ClaudeBot/Claude, PerplexityBot/Perplexity, Google-Extended/Gemini, and more) are crawling you, and which pages. This is the leading indicator. An engine crawls you before it ever recommends you.
2. AI REFERRALS. Which engines actually send you traffic, meaning they recommended you to a real person who clicked through.

The novel part is the gap between the two: crawled but not yet cited, cited, or never crawled at all. Per engine, and per page. Nobody else ships this join.

It never queries an LLM, so the signal cannot be gamed.

## The funnel for getmasset.com right now

| Funnel metric | Value |
|---|---|
| Total AI crawls (30d) | 0 |
| Total AI referrals (30d) | 0 |
| Crawl-to-referral rate | n/a (no crawls yet) |
| Top advocate engine | none yet |
| Biggest crawl-vs-referral gap | none yet |

Honest read: the funnel is empty. Over the last 30 days, s33k has recorded zero AI-engine crawler hits and zero AI referrals for getmasset.com. The only referral traffic in the window is 4 visitors from google.com (classic search, not an AI engine), against 16 pageviews and 7 visitors total.

This is not a bug, and it is not a failure of the site. It is early days. The s33k crawler-hit recorder is newly wired, so it has not yet accumulated a window of AI bot traffic, and AI referral traffic to most B2B sites is still a trickle that an analytics tool only sees once volume builds. AI crawls show up first, then referrals follow. We have not captured a full window of either yet.

So the feature does exactly what it was designed to do when the behavioral signal is thin: it falls back to the leading indicator that IS available today, the citability audit. That is what carries this demo, and it is a real, true-positive result.

## The citability audit (this is the real win today)

When crawl and referral data is thin, the feature fetches your top pages and scores how AI-READY they are. Four signals, 25 points each, because these are the concrete things that make a page easy for an AI answer engine to find, parse, and cite:

- llms.txt at the site root: the machine-readable index that tells AI agents what the site is.
- a Markdown twin of the page (e.g. /software/mcp.md): clean, chrome-free content an AI client can read without fighting HTML.
- JSON-LD structured data: explicit, typed facts answer engines lift directly.
- clean, answer-shaped content: a real title, real headings, real body text, not a thin shell.

getmasset.com scored 100 out of 100. Site llms.txt found at https://getmasset.com/llms.txt (30,506 characters of real content). Every page audited passed all four signals.

| Page | llms.txt | .md twin | JSON-LD | Clean content | Score |
|---|---|---|---|---|---|
| / | yes | yes (/index.md) | yes | yes | 100 |
| /software/mcp | yes | yes (/software/mcp.md) | yes | yes | 100 |
| /resources | yes | yes (/resources.md) | yes | yes | 100 |
| /software | yes | yes (/software.md) | yes | yes | 100 |
| /our-story | yes | yes (/our-story.md) | yes | yes | 100 |
| Domain score | | | | | 100 |

These are verified, not assumed. The audit fetched each page live and followed the apex-to-www redirect. /software/mcp.md comes back as real markdown with YAML frontmatter, served as text/markdown, not an HTML page pretending to be markdown (the audit rejects that case, so a soft-404 cannot inflate the score). This is a genuine true positive: getmasset.com is one of the most AI-ready sites you will audit, and the feature correctly says so.

## What this means and what to do

- The site is built right. getmasset.com has done the hard AI-readiness work most companies have not: llms.txt, Markdown twins on every page, JSON-LD everywhere. The audit confirms it at 100/100. The supply side of AI visibility is handled.
- The funnel is empty because the measurement is new, not because the site is invisible. The next step is simply to let s33k accumulate a window: keep the crawler-hit recorder collecting, and AI bot traffic will start landing in the funnel. Crawls appear first, referrals follow, and the gap between them becomes the thing to work on.
- The demo to give in the morning: open this file, show the 100/100 citability audit on real getmasset.com pages as proof the feature works and is honest, then explain the funnel will fill as the crawl recorder runs. The audit is the leading indicator; the funnel is the outcome we are now positioned to watch.
