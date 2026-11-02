// Minimal "custom headless" storefront for demonstrating storefront toolkit preview.
// No framework, no dependencies. Not production code.
//
// - Holds a SLAS private client (the "storefront" client) and issues guest shopper tokens
// - Proxies a few Shopper API calls (SCAPI has no browser CORS)
// - Serves a static page that hands its shopper token to the ECOM storefront toolkit
//   wrapper (parent frame) and re-renders when the parent says context was set

import http from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import path from 'node:path'

const {
    PORT = 3000,
    SCAPI_SHORT_CODE,
    SCAPI_ORG_ID,
    SITE_ID = 'RefArchGlobal',
    SLAS_CLIENT_ID,
    SLAS_CLIENT_SECRET,
    // comma separated list of hostname suffixes allowed to frame this app / receive tokens
    PREVIEW_PARENT_HOSTS = 'dx.commercecloud.salesforce.com,demandware.net'
} = process.env

for (const [k, v] of Object.entries({SCAPI_SHORT_CODE, SCAPI_ORG_ID, SLAS_CLIENT_ID, SLAS_CLIENT_SECRET})) {
    if (!v) {
        console.error(`Missing env ${k} (see ../.env.example)`)
        process.exit(1)
    }
}

const SCAPI = `https://${SCAPI_SHORT_CODE}.api.commercecloud.salesforce.com`
const SLAS = `${SCAPI}/shopper/auth/v1/organizations/${SCAPI_ORG_ID}`
const BASIC = 'Basic ' + Buffer.from(`${SLAS_CLIENT_ID}:${SLAS_CLIENT_SECRET}`).toString('base64')
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const parentHosts = PREVIEW_PARENT_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)

async function slasToken(form) {
    const resp = await fetch(`${SLAS}/oauth2/token`, {
        method: 'POST',
        headers: {Authorization: BASIC, 'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({channel_id: SITE_ID, ...form})
    })
    const body = await resp.json()
    return {status: resp.status, body}
}

// Only expose what the browser needs
const tokenView = ({access_token, refresh_token, usid, customer_id, expires_in}) => ({
    access_token,
    refresh_token,
    usid,
    customer_id,
    expires_in
})

async function shopperApi(req, apiPath, query) {
    const qs = new URLSearchParams({siteId: SITE_ID, ...query})
    const resp = await fetch(`${SCAPI}/${apiPath.replace('{org}', SCAPI_ORG_ID)}?${qs}`, {
        headers: {Authorization: req.headers.authorization || ''}
    })
    return {status: resp.status, body: await resp.json().catch(() => ({}))}
}

const routes = {
    'GET /api/config': async () => ({status: 200, body: {siteId: SITE_ID, parentHosts}}),

    // guest login (or refresh with ?refresh_token=)
    'POST /api/token': async (req, url, body) => {
        const refresh = body.refresh_token
        const result = refresh
            ? await slasToken({grant_type: 'refresh_token', refresh_token: refresh})
            : await slasToken({grant_type: 'client_credentials'})
        return result.status === 200 ? {status: 200, body: tokenView(result.body)} : result
    },

    // what SCAPI believes this shopper's context is (requires sfcc.shopper-context scope)
    'GET /api/context': async (req, url) =>
        shopperApi(req, `shopper/shopper-context/v1/organizations/{org}/shopper-context/${url.searchParams.get('usid')}`),

    'GET /api/search': async (req, url) =>
        shopperApi(req, 'search/shopper-search/v1/organizations/{org}/product-search', {
            q: url.searchParams.get('q') || '',
            limit: '12',
            expand: 'prices,promotions,images',
            allImages: 'false',
            currency: url.searchParams.get('currency') || ''
        }),

    'GET /api/promotions': async (req, url) =>
        shopperApi(req, 'pricing/shopper-promotions/v1/organizations/{org}/promotions', {
            ids: url.searchParams.get('ids') || ''
        })
}

const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}

async function serveStatic(res, pathname) {
    const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname)
    if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end()
        return
    }
    try {
        const data = await readFile(file)
        const frameAncestors = ["'self'", ...parentHosts.map((h) => `https://*.${h}`)].join(' ')
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            // allow being framed only by the storefront toolkit (ECOM) hosts
            'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
            'Cache-Control': 'no-store'
        })
        res.end(data)
    } catch {
        res.writeHead(404).end('Not found')
    }
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const handler = routes[`${req.method} ${url.pathname}`]
    if (!handler) {
        return serveStatic(res, url.pathname)
    }
    try {
        let body = {}
        if (req.method === 'POST') {
            let raw = ''
            for await (const chunk of req) raw += chunk
            body = raw ? JSON.parse(raw) : {}
        }
        const result = await handler(req, url, body)
        res.writeHead(result.status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
        res.end(JSON.stringify(result.body))
    } catch (e) {
        console.error(e)
        res.writeHead(500, {'Content-Type': 'application/json'}).end(JSON.stringify({error: e.message}))
    }
}).listen(PORT, () => console.log(`Headless demo storefront for ${SITE_ID} on http://localhost:${PORT}`))
