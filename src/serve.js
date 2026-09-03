// A server for the output, for as long as the audit takes.
//
// Lighthouse measures a page as a browser receives it, so it needs an origin —
// `file://` is not one: no protocol-relative urls, no service worker, no
// caching headers, and several audits silently score differently. So the
// output is served rather than opened.
//
// Ephemeral port, bound to loopback. Not the project's own `--server`: that
// one may not be running, may be serving a different folder, and taking a
// dependency on it would make the audit's result depend on how the developer
// happened to start their day.

import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml', '.pdf': 'application/pdf',
}

export async function serveOutput(root) {
    const server = http.createServer(async (request, response) => {
        try {
            const url = decodeURIComponent((request.url ?? '/').split('?')[0])
            // Contained: a request cannot climb out of the output folder, even
            // though this only ever listens on loopback for a few seconds.
            let file = path.resolve(root, `.${url}`)
            if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) {
                response.writeHead(403); response.end(); return
            }
            let info = await stat(file).catch(() => null)
            // cleanUrls puts a page at <name>/index.html, which is what the
            // links point at — so a directory has to resolve the way a real
            // server resolves it or every audit lands on a 404.
            if (info?.isDirectory()) {
                file = path.join(file, 'index.html')
                info = await stat(file).catch(() => null)
            }
            if (!info?.isFile()) { response.writeHead(404); response.end('not found'); return }
            response.writeHead(200, {
                'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
                'content-length': info.size,
                // Lighthouse reports an uncached response as a finding, and on
                // a static host it would be cached. Saying so keeps the audit
                // about the SITE rather than about this throwaway server.
                'cache-control': 'public, max-age=3600',
            })
            createReadStream(file).pipe(response)
        } catch {
            response.writeHead(500); response.end()
        }
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    return {
        origin: `http://127.0.0.1:${port}`,
        async close() { await new Promise(resolve => server.close(resolve)) },
    }
}
