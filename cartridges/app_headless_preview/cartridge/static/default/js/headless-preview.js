/**
 * Parent (ECOM / storefront toolkit) side of the headless preview protocol.
 *
 * Protocol (window.postMessage, origins checked on both ends). Either side may start, and
 * every message is safe to repeat, so neither load order nor a lost message breaks it:
 *   parent -> app    {type: 'headless-preview:parent-ready'}   on iframe load ("send me your token")
 *   app    -> parent {type: 'headless-preview:token', token}  on app start and on parent-ready
 *   parent -> app    {type: 'headless-preview:context-set', ok, cached, context, error}
 *
 * The app should refetch data on `context-set` so SCAPI responses reflect the new context.
 *
 * Loaded in <head> before the iframe exists; the frame is looked up lazily.
 */
(function () {
    var config = window.__headlessPreview;
    var appOrigin = new URL(config.previewURL, window.location.href).origin;
    var lastToken = sessionStorage.getItem('headless-preview-token');
    var inflight = {}; // token -> Promise, dedupes repeated token messages

    function frameWindow() {
        var frame = document.getElementById('headlessPreviewFrame');
        return frame && frame.contentWindow;
    }

    function post(message) {
        var win = frameWindow();
        if (win) {
            win.postMessage(message, appOrigin);
        }
    }

    async function doSetContext(token) {
        if (token === lastToken && config.proactiveContextSet) {
            // Default-Start already set the context for this shopper on this (re)load
            return { ok: true, context: config.previewContext, cached: true };
        }
        var resp = await fetch(config.setContextEndpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ jwt: token }).toString()
        });
        var data = await resp.json().catch(function () { return {}; });
        if (resp.ok && data.success) {
            lastToken = token;
            config.proactiveContextSet = true; // subsequent repeats for this token are no-ops
            sessionStorage.setItem('headless-preview-token', token);
            return { ok: true, context: data.context };
        }
        return { ok: false, error: data.error || 'HTTP ' + resp.status };
    }

    function setContext(token) {
        if (!inflight[token]) {
            inflight[token] = doSetContext(token).finally(function () {
                delete inflight[token];
            });
        }
        return inflight[token];
    }

    window.addEventListener('message', async function (event) {
        if (event.origin !== appOrigin || event.source !== frameWindow()) {
            return;
        }
        if (event.data && event.data.type === 'headless-preview:token' && event.data.token) {
            var result = await setContext(event.data.token);
            console.log('[headless-preview] context', result);
            post({
                type: 'headless-preview:context-set',
                ok: result.ok,
                cached: !!result.cached,
                context: result.context,
                error: result.error
            });
        }
    });

    // If the app posted before we were listening (or a message was dropped) ask again
    // once the iframe has loaded.
    document.addEventListener('DOMContentLoaded', function () {
        var frame = document.getElementById('headlessPreviewFrame');
        frame.addEventListener('load', function () {
            post({ type: 'headless-preview:parent-ready' });
        });
    });
})();
