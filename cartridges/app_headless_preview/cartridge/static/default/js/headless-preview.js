/**
 * Parent (ECOM / storefront toolkit) side of the headless preview protocol.
 *
 * Protocol (window.postMessage, origins checked on both ends; the app initiates so there is
 * no race with the iframe load event):
 *   app    -> parent {type: 'headless-preview:token', token}       app's SLAS access token
 *   parent -> app   {type: 'headless-preview:context-set', ok, cached, context, error}
 *
 * The app should refetch/reload data on `context-set` so SCAPI responses reflect the new
 * shopper context.
 */
(function () {
    var config = window.__headlessPreview;
    var frame = document.getElementById('headlessPreviewFrame');
    var appOrigin = new URL(config.previewURL, window.location.href).origin;
    var lastToken = sessionStorage.getItem('headless-preview-token');

    function post(message) {
        frame.contentWindow.postMessage(message, appOrigin);
    }

    async function setContext(token) {
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
            sessionStorage.setItem('headless-preview-token', token);
            return { ok: true, context: data.context };
        }
        return { ok: false, error: data.error || 'HTTP ' + resp.status };
    }

    window.addEventListener('message', async function (event) {
        if (event.origin !== appOrigin || event.source !== frame.contentWindow) {
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
})();
