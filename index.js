// Lighthouse against the output a build just produced.
//
// This is the deliberate other side of mikser-io-lint. That plugin draws a
// line at facts a parser can state and refuses to cross it: no CSS, no layout,
// no browser. Everything on the far side of that line still matters — whether
// the page is fast, whether a screen reader can navigate it, whether the
// markup a search engine needs is there — and none of it can be known without
// actually loading the page.
//
// So this one loads it, and pays for that honestly:
//
//   - a real audit of a trivial page takes ~6 SECONDS. On thirteen pages that
//     is a minute and a half.
//   - it needs Chrome, which is a host binary and not an npm dependency.
//
// Both facts shape when it runs. It does NOT run in watch or server mode: a
// project whose documented dev model is a watcher always up would pay six
// seconds a keystroke, and a check that makes the loop unusable is a check
// that gets removed. One-shot builds — which is CI, and a deliberate local
// run — pay for it.

import path from 'node:path'
import { access, constants } from 'node:fs/promises'
import lighthouse from 'lighthouse'
import * as chromeLauncher from 'chrome-launcher'

import { cliOption } from 'mikser-io'
import { serveOutput } from './src/serve.js'

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo']

// 90 is Lighthouse's own boundary for "good" — the point its report turns
// green. Borrowing it rather than inventing a number means the threshold here
// and the number a person sees in Chrome agree about what passing means.
const DEFAULT_THRESHOLD = 90

// Audits that measure THIS PLUGIN'S SERVER rather than the deployment.
//
// The output is served from an ephemeral loopback process for the length of
// the audit — that is deliberate, and it is why the result does not depend on
// whether a dev server happens to be running. The cost is that anything
// header-shaped or transport-shaped is a fact about that throwaway server:
// cache lifetimes are nginx's in production and the response time is a local
// file read.
//
// Compression is the exception, and it is not excluded-and-forgotten. The
// server COMPRESSES the way a configured host does, because the score is not
// only made of these line items: Lighthouse derives FCP and LCP from the bytes
// that actually arrive, so serving text uncompressed depresses the score
// against a production that compresses — and the audit is then pessimistic in
// a way no line item explains. The audit below stays excluded because whether
// the real host is configured is still the host's fact, not the site's; the
// server models a host that is.
//
// Reported downstream as a finding that is "right about what it measured and
// unactionable by construction". Excluded rather than explained away, because
// a finding nobody can act on trains a reader to skim the ones they can. A
// project that fronts its own server can put them back through `audits`.
const SERVER_SHAPED_AUDITS = new Set([
    'uses-long-cache-ttl',
    'cache-insight',
    'uses-text-compression',
    'server-response-time',
    'redirects',
    'uses-http2',
])

export function lighthouseAudit(options = {}) {
    return ({ runtime, onFinalized, useLogger }) => {
        cliOption('--lighthouse',
            'audit the built pages with Lighthouse — performance, accessibility, best practices '
            + 'and SEO. Loads each page in Chrome, so it costs about six seconds per page and is '
            + 'never run unless asked for.')

        onFinalized(async () => {
            const logger = useLogger()
            const outputFolder = runtime.options?.outputFolder
            if (!outputFolder) return

            // Asked for, or not run.
            //
            // "Not watch or server" was the wrong question. On a project whose
            // dev model is a watcher always up, the builds that are neither
            // are the ones an upgrade script runs — nine per release check,
            // each auditing, three minutes added to a two-minute check. And
            // `requested` cannot separate those: a verification build is
            // exactly as requested as a person typing one. What distinguishes
            // them is INTENT, and only the caller can state it.
            //
            // So it is a flag: on --help beside the other checks, refused out
            // loud when misspelled, and impossible to trigger by accident from
            // a script that only wanted a build. `always: true` in config for
            // a project that wants every build audited.
            if (!options.always && !runtime.options.lighthouse) return

            // After a successful BUILD, for the same reason lint is: auditing
            // half a site reports on documents that were never finished, and
            // every one of those findings is noise on top of the error that
            // already explains it.
            const { renderErrorCount, cycleMovedNothing } = await import('mikser-io')
            if (renderErrorCount()) {
                // Loud, not debug: the flag was passed, so someone is waiting
                // for scores and getting none. "Audited and fine" and "did not
                // run" are indistinguishable otherwise — the argument this
                // plugin already makes one level down about printing scores
                // even when they pass applies to the stand-down itself.
                logger.warn({ code: 'lighthouse-not-run', reason: 'render-errors' },
                    'Lighthouse did not run: the build has render errors, so half the site is on disk '
                    + 'and auditing it would report on documents that were never finished.')
                return
            }

            // A cycle that moved nothing produced the bytes the last one did,
            // so the audit would reprint the last audit — for six seconds a
            // page. Measured downstream at 19s for a no-op build.
            if (cycleMovedNothing()) {
                logger.warn({ code: 'lighthouse-not-run', reason: 'nothing-changed' },
                    'Lighthouse did not run: nothing rendered and nothing changed, so the output is '
                    + 'the one the last audit already scored. Use --force to re-render and audit again.')
                return
            }

            // Which pages. Small on purpose — auditing everything is minutes,
            // and the answer for page 40 is almost always the answer for page
            // 1 plus its own content. The site roots are the default because
            // they are the pages that exist on every site and the ones a
            // visitor arrives at.
            const roots = runtime.config?.siteRoots ?? []
            const pages = options.pages ?? (roots.length ? roots.map(root => `/${root}/`) : ['/'])
            if (!pages.length) return

            const threshold = options.threshold ?? DEFAULT_THRESHOLD
            const categories = options.categories ?? CATEGORIES

            // A configured binary is checked BEFORE it is handed to
            // chrome-launcher.
            //
            // launch() spawns it, and a spawn failure arrives as an unhandled
            // 'error' event on a child process this code does not own — which
            // is outside any promise, so no try/catch here can see it and the
            // whole build dies with a Node stack dump. A path that does not
            // exist is the ordinary way to get there: a pinned Chrome that
            // moved, or a container image without one.
            //
            // Only for an explicit path. When none is given, chrome-launcher
            // searches the host and rejects cleanly if it finds nothing, which
            // the catch below turns into a fault.
            if (options.chromePath) {
                try {
                    await access(options.chromePath, constants.X_OK)
                } catch {
                    logger.error({ code: 'lighthouse-unavailable', chromePath: options.chromePath },
                        'Lighthouse was given chromePath %j, which is not an executable file, so '
                        + 'nothing was audited. The build is otherwise unaffected.', options.chromePath)
                    return
                }
            }

            let chrome
            let server
            try {
                server = await serveOutput(outputFolder)
                // Launched ONCE for every page, not once per page: the launch
                // is half a second and the audit is six, so a per-page launch
                // would add ten percent for nothing.
                chrome = await chromeLauncher.launch({
                    chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'],
                    // An explicit binary, for a project that pins one — and
                    // the only way to exercise the failure below, since
                    // chrome-launcher searches the host and finds a browser
                    // even when CHROME_PATH names nothing.
                    ...(options.chromePath ? { chromePath: options.chromePath } : {}),
                })
            } catch (err) {
                await server?.close()
                // A FAULT, not a crash and not silence: a subsystem saying it
                // cannot do its job. Chrome is a host binary, so this is the
                // expected state on a machine that has never installed one —
                // and a build that quietly skipped its audit would report
                // success having checked nothing.
                logger.error({ code: 'lighthouse-unavailable' },
                    'Lighthouse could not start Chrome, so nothing was audited (%s). The build is '
                    + 'otherwise unaffected. Chrome is a host binary rather than an npm dependency: '
                    + 'install it, or set a path with CHROME_PATH.', err.message)
                return
            }

            const excluded = options.audits === false
                ? new Set()
                : new Set([...SERVER_SHAPED_AUDITS, ...(options.excludeAudits ?? [])])
            const scores = []
            const skippedAudits = new Set()
            const failures = new Map()
            try {
                for (const page of pages) {
                    const url = new URL(page, server.origin).href
                    let result
                    try {
                        result = await lighthouse(url, {
                            port: chrome.port, output: 'json', logLevel: 'silent',
                            onlyCategories: categories,
                        })
                    } catch (err) {
                        logger.warn({ code: 'lighthouse-page-failed', page },
                            'Lighthouse could not audit %s: %s', page, err.message)
                        continue
                    }
                    if (!result?.lhr) continue

                    const page_ = { page, categories: {} }
                    for (const [id, category] of Object.entries(result.lhr.categories)) {
                        page_.categories[id] = Math.round((category.score ?? 0) * 100)
                    }
                    scores.push(page_)

                    for (const audit of Object.values(result.lhr.audits)) {
                        if (audit.score === null || audit.score >= 1) continue
                        if (excluded.has(audit.id)) { skippedAudits.add(audit.id); continue }
                        if (!failures.has(audit.id)) {
                            failures.set(audit.id, { title: audit.title, pages: [] })
                        }
                        failures.get(audit.id).pages.push(page)
                    }
                }
            } finally {
                // kill() is SYNCHRONOUS in chrome-launcher, so `.catch()` on
                // its undefined return threw a TypeError out of this finally —
                // which discarded every result gathered above and produced a
                // build that ran the audit for six seconds and printed
                // nothing. Wrapped rather than chained, and never allowed to
                // mask what it is cleaning up after.
                try { chrome.kill() } catch { /* already gone */ }
                await server.close().catch(() => {})
            }

            if (!scores.length) {
                // Not silence. Reaching here means Chrome started, the pages
                // were served, and every audit still came back empty — which
                // is a different thing from "nothing to report" and looks
                // identical from outside unless it says so.
                logger.warn({ code: 'lighthouse-no-results', pages: pages.length },
                    'Lighthouse audited %d page(s) and produced no result for any of them. '
                    + 'Chrome started, so this is not a missing browser — the pages may not be '
                    + 'reachable at the paths given (%s).', pages.length, pages.join(', '))
                return
            }

            // The scores, always — a passing audit is worth saying out loud,
            // because "no output" and "not run" look identical otherwise, and
            // this plugin is skipped often enough that the difference matters.
            for (const { page, categories: got } of scores) {
                const line = Object.entries(got).map(([id, score]) => `${id} ${score}`).join(', ')
                const below = Object.entries(got).filter(([, score]) => score < threshold)
                if (below.length) {
                    logger.warn({ code: 'lighthouse-below-threshold', page, scores: got, threshold },
                        '%s — %s. Below %d: %s.', page, line, threshold,
                        below.map(([id]) => id).join(', '))
                } else {
                    logger.notice({ code: 'lighthouse-scores', page, scores: got }, '%s — %s', page, line)
                }
            }

            // Failing audits grouped by audit, not by page, for the reason
            // lint groups by rule: one mistake in a layout fails on every page
            // that uses it, and a per-page listing turns a single fix into a
            // wall.
            const SHOWN = 10
            const ordered = [...failures].sort((a, b) => b[1].pages.length - a[1].pages.length)
            for (const [id, { title, pages: on }] of ordered.slice(0, SHOWN)) {
                logger.warn({ code: `lighthouse-${id}`, audit: id, pages: on.length },
                    '%s — %s (on %d page(s))', id, title, on.length)
            }
            if (skippedAudits.size) {
                // Split, because the two reasons are different and lumping
                // them would misdescribe whichever list the reader cares
                // about: one is this plugin's own doing, the other is theirs.
                const serverShaped = [...skippedAudits].filter(id => SERVER_SHAPED_AUDITS.has(id)).sort()
                const asked = [...skippedAudits].filter(id => !SERVER_SHAPED_AUDITS.has(id)).sort()
                if (serverShaped.length) {
                    logger.info('Not reported — these measure the audit server rather than your '
                        + 'deployment (cache headers, compression and response time are your host\'s): %s',
                        serverShaped.join(', '))
                }
                if (asked.length) {
                    logger.info('Not reported — excluded by config: %s', asked.join(', '))
                }
            }
            if (ordered.length) {
                logger.warn({ code: 'lighthouse-summary', audits: ordered.length,
                    pages: scores.length, threshold, excluded: [...skippedAudits].sort() },
                    '%d failing audit(s) across %d page(s)%s. These needed a browser — everything a '
                    + 'parser could have told you is in the lint pass instead.',
                    ordered.length, scores.length,
                    ordered.length > SHOWN ? `, ${SHOWN} shown` : '')
            }
        })

        return { collection: 'lighthouse', type: 'lighthouse' }
    }
}

export { lighthouseAudit as lighthouse }
export default lighthouseAudit
