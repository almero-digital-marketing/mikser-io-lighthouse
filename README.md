# mikser-io-lighthouse

Lighthouse against the output a mikser build produced.

```js
import { lighthouse } from 'mikser-io-lighthouse'

export default {
    plugins: [documents(), files(), frontMatter(), layouts(), renderHbs(), lighthouse()],
}
```

## The other side of the line

[`mikser-io-lint`](https://github.com/almero-digital-marketing/mikser-io-lint)
draws a line at facts a parser can state and refuses to cross it: no CSS, no
layout, no browser. Everything on the far side of that line still matters —
whether the page is fast, whether a screen reader can navigate it, whether the
markup a search engine needs is there — and none of it can be known without
loading the page.

This loads it, and pays for that honestly.

## When it runs

Only when you ask:

```bash
mikser --lighthouse
```

A real audit of a trivial page takes **about six seconds**. On thirteen pages
that is a minute and a half — so it is opt-in rather than
not-prevented.

The first version keyed off "not watch or server" instead, which was wrong for
exactly the projects this is written for. Where a watcher is always up, the
builds that are *neither* are the ones an upgrade script runs — nine per
release check — and every one of them audited: three minutes added to a
two-minute check. `requested` does not separate those either, because a
verification build is exactly as requested as a person typing one. What
distinguishes them is intent, and only a caller can state it.

The flag works with nothing listening and forwarded to a running watcher alike.
It needs `mikser-io@9.100.0`, which is where a plugin can declare an option at
all.

```js
lighthouse({ always: true })   // audit every build, if a project wants that
```

It also stands down when the build has render errors, for the same reason lint
does: auditing half a site reports on documents that were never finished.

## What it reports

The scores, every time — including when they pass, because "no output" and "not
run" look identical otherwise and this plugin is skipped often enough that the
difference matters.

```
🟢 [lighthouse-scores] / — performance 100, accessibility 95, best-practices 96, seo 91
🟡 [lighthouse-unsized-images] unsized-images — Image elements do not have explicit
   `width` and `height` (on 1 page(s))
🟡 [lighthouse-summary] 4 failing audit(s) across 1 page(s). These needed a browser —
   everything a parser could have told you is in the lint pass instead.
```

Failing audits are grouped by audit rather than by page: one mistake in a
layout fails on every page that uses it. Every line carries a stable code, and
findings reach `--json` as well as the console — they go through the same
`logger.warn` channel core uses, which is the only channel.

A category below the threshold is reported as such:

```
🟡 [lighthouse-below-threshold] / — performance 62, accessibility 95 … Below 90: performance.
```

90 is Lighthouse's own boundary for "good" — the point its report turns green.
Borrowing it rather than inventing a number means this and the number you see in
Chrome agree about what passing means.

## Chrome

Chrome is a **host binary**, not an npm dependency. When it cannot be started
the plugin raises a fault and the build continues:

```
🔴 [lighthouse-unavailable] Lighthouse could not start Chrome, so nothing was audited.
```

`chromePath` pins a specific binary. It is checked before use, because
`chrome-launcher` spawns it and a spawn failure arrives as an unhandled `error`
event on a child process — outside any promise, so it took the whole build down
with a Node stack dump before that check existed.

## Options

```js
lighthouse({
    pages: ['/', '/en/', '/about/'],   // default: the site roots, or '/'
    categories: ['performance', 'accessibility', 'best-practices', 'seo'],
    threshold: 90,
    chromePath: '/usr/bin/google-chrome',
    always: false,
})
```

`pages` is small by default on purpose. Auditing everything is minutes, and the
answer for page 40 is usually the answer for page 1 plus its own content.

## What it does not do

It serves the output itself, on an ephemeral loopback port, for as long as the
audit takes. Not your `--server`: that may not be running, may be serving a
different folder, and depending on it would make the result depend on how you
happened to start your day.

## Licence

MIT
