// Browser side of the demo storefront.
//
// The only "preview" specific code is the `connectToPreviewParent` function: if we're framed
// by an allowed ECOM host (storefront toolkit) we send our shopper access token to the
// parent; the ECOM cartridge validates it, gets a TSOB token for our USID and copies its
// preview context (customer groups, effective date, source code) into SCAPI Shopper Context.
// Every subsequent SCAPI call made with our *normal* shopper token then reflects that context.

const $ = (id) => document.getElementById(id)
const show = (id, value) => ($(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2))

const config = await (await fetch('/api/config')).json()

// ---- auth (guest only; stored per-tab so each preview session gets its own USID) ----
let inflight = null
function getToken() {
    // share a single in-flight request so concurrent callers get the same USID
    inflight ??= fetchToken().finally(() => (inflight = null))
    return inflight
}

async function fetchToken() {
    const cached = JSON.parse(sessionStorage.getItem('shopper-token') || 'null')
    if (cached && cached.expires_at > Date.now() + 60_000) return cached

    const resp = await fetch('/api/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(cached?.refresh_token ? {refresh_token: cached.refresh_token} : {})
    })
    if (!resp.ok) {
        sessionStorage.removeItem('shopper-token')
        throw new Error('Unable to get shopper token: ' + (await resp.text()))
    }
    const token = await resp.json()
    token.expires_at = Date.now() + token.expires_in * 1000
    sessionStorage.setItem('shopper-token', JSON.stringify(token))
    return token
}

async function api(path) {
    const {access_token} = await getToken()
    const resp = await fetch(path, {headers: {Authorization: `Bearer ${access_token}`}})
    return resp.json()
}

// ---- rendering ----
async function renderContext() {
    const {usid} = await getToken()
    show('usid', usid)
    show('scapiContext', await api(`/api/context?usid=${usid}`))
}

async function renderSearch() {
    const q = $('q').value
    const result = await api(`/api/search?q=${encodeURIComponent(q)}`)
    $('results').innerHTML = ''
    for (const hit of result.hits || []) {
        const tile = document.createElement('div')
        tile.className = 'tile'
        const promos = (hit.productPromotions || []).map((p) => p.calloutMsg || p.promotionId)
        tile.innerHTML = `
            <img loading="lazy" alt="" src="${hit.image?.disBaseLink || ''}?sw=240" />
            <div class="name"></div>
            <div class="price">${hit.price != null ? `${hit.price} ${hit.currency}` : ''}</div>
            <div class="promo"></div>`
        tile.querySelector('.name').textContent = hit.productName
        tile.querySelector('.promo').textContent = promos.join(' • ')
        $('results').append(tile)
    }
    if (!result.hits) show('results', result)
}

async function renderAll() {
    await Promise.all([renderContext(), renderSearch()])
}

// ---- storefront toolkit / ECOM preview connector ----
function getParentOrigin() {
    if (window.parent === window) return null
    // ancestorOrigins is Chromium/Safari; fall back to referrer (Firefox)
    const origin = window.location.ancestorOrigins?.[0] || (document.referrer && new URL(document.referrer).origin)
    return origin || null
}

function connectToPreviewParent() {
    const parentOrigin = getParentOrigin()
    if (!parentOrigin) return
    const host = new URL(parentOrigin).hostname
    if (!config.parentHosts.some((h) => host === h || host.endsWith('.' + h))) {
        show('status', `framed by untrusted origin ${parentOrigin}; ignoring`)
        return
    }

    $('mode').textContent = 'storefront preview'
    $('mode').classList.add('preview')
    show('status', 'connecting to ECOM preview…')

    let acked = false
    const sendToken = async () => {
        const {access_token} = await getToken()
        window.parent.postMessage({type: 'headless-preview:token', token: access_token}, parentOrigin)
    }

    window.addEventListener('message', async (event) => {
        if (event.origin !== parentOrigin || event.source !== window.parent) return
        const msg = event.data || {}

        // parent (re)announced itself: it may have missed our first token message
        if (msg.type === 'headless-preview:parent-ready' && !acked) {
            sendToken()
        }

        if (msg.type === 'headless-preview:context-set') {
            // a retried token can be acked more than once; only re-render the first time
            const first = !acked
            acked = true
            show('status', msg.ok ? `shopper context set${msg.cached ? ' (proactively, on reload)' : ''}` : `error: ${msg.error}`)
            if (msg.context) show('ecomContext', msg.context)
            // context changed -> refetch everything so SCAPI responses reflect it
            if (first) await renderAll()
        }
    })

    // hand our shopper token to the ECOM wrapper; retry a few times until acknowledged
    // (the parent ignores duplicates)
    sendToken()
    let attempts = 0
    const retry = setInterval(() => {
        if (acked || ++attempts > 5) {
            clearInterval(retry)
            if (!acked) show('status', 'no response from ECOM preview wrapper')
            return
        }
        sendToken()
    }, 1000)
}

$('refresh').addEventListener('click', renderContext)
$('searchForm').addEventListener('submit', (e) => {
    e.preventDefault()
    renderSearch()
})

connectToPreviewParent()
renderAll()
