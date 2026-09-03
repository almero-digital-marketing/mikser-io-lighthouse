// The server exists because Lighthouse measures a page as a browser receives
// it, and `file://` is not an origin. These are the four things it has to get
// right for an audit to be about the SITE rather than about the server.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveOutput } from '../src/serve.js'

describe('serveOutput', () => {
    let root, server

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mio-lh-serve-'))
        await mkdir(path.join(root, 'about'), { recursive: true })
        await writeFile(path.join(root, 'index.html'), '<!doctype html><title>root</title>')
        await writeFile(path.join(root, 'about', 'index.html'), '<!doctype html><title>about</title>')
        await writeFile(path.join(root, 'styles.css'), '.a{color:red}')
        server = await serveOutput(root)
    })
    after(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })

    const get = async (url) => {
        const response = await fetch(new URL(url, server.origin))
        return { status: response.status, type: response.headers.get('content-type'),
            cache: response.headers.get('cache-control'), body: await response.text() }
    }

    it('serves the root', async () => {
        const { status, body } = await get('/')
        assert.equal(status, 200)
        assert.match(body, /<title>root<\/title>/)
    })

    it('resolves a directory to its index, which is where cleanUrls puts a page', async () => {
        // Without this every audit of a clean url lands on a 404 and reports
        // on an error page — scoring the wrong document with total confidence.
        const { status, body } = await get('/about/')
        assert.equal(status, 200)
        assert.match(body, /<title>about<\/title>/)
    })

    it('sends a content type, because several audits depend on it', async () => {
        assert.match((await get('/styles.css')).type, /text\/css/)
        assert.match((await get('/')).type, /text\/html/)
    })

    it('sends cache headers a static host would send', async () => {
        // Lighthouse reports an uncached response as a finding. On a real host
        // it would be cached, so saying so keeps the audit about the site
        // rather than about this throwaway server.
        assert.match((await get('/')).cache, /max-age/)
    })

    it('404s what is not there rather than hanging', async () => {
        assert.equal((await get('/nope.html')).status, 404)
    })

    it('refuses a path that climbs out of the output folder', async () => {
        const response = await fetch(`${server.origin}/../../etc/passwd`, { redirect: 'manual' })
        assert.notEqual(response.status, 200)
    })

    it('binds loopback only, and picks its own port', async () => {
        assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    })
})
