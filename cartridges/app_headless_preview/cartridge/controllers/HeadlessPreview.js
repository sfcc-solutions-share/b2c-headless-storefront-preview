'use strict';

/**
 * HeadlessPreview-SetContext
 *
 * Sets the SCAPI Shopper Context of the shopper identified by the posted SLAS access token
 * to the ECOM context of the *current request*.
 *
 * The context written is computed here on the server from the current session; the
 * browser only supplies a shopper token. Access is gated by checkPreviewAllowed()
 * (BM session required / disabled on production by default) and a same-origin check.
 *
 * POST application/x-www-form-urlencoded: jwt=<SLAS shopper access token>
 *
 * Bare controller with no SFRA dependency, so it works on any cartridge path.
 */

var helpers = require('*/cartridge/scripts/headless-preview/helpers');
var Logger = require('dw/system/Logger').getLogger('headless-preview', 'headless-preview');

/**
 * Only accept requests from the wrapper page, which is served from this same host.
 * Browsers always send Origin on cross-origin POSTs, so a missing header is not a
 * cross-site request.
 */
function isSameOrigin() {
    var origin = request.httpHeaders.get('origin');
    return !origin || origin === 'https://' + request.httpHost;
}

function sendJSON(status, body) {
    response.setStatus(status);
    response.setContentType('application/json');
    response.writer.print(JSON.stringify(body));
}

function SetContext() {
    if (request.httpMethod !== 'POST') {
        sendJSON(405, { error: 'POST required' });
        return;
    }

    if (!isSameOrigin()) {
        sendJSON(403, { error: 'Cross-origin request rejected' });
        return;
    }

    var allowed = helpers.checkPreviewAllowed();
    if (!allowed.allowed) {
        Logger.warn('SetContext rejected: {0}', allowed.reason);
        sendJSON(403, { error: allowed.reason });
        return;
    }

    var jwt = request.httpParameterMap.jwt.stringValue;
    if (!jwt) {
        sendJSON(400, { error: 'jwt parameter required' });
        return;
    }

    var token = helpers.inspectShopperToken(jwt);
    if (!token.valid) {
        sendJSON(400, { error: token.error });
        return;
    }

    // remember the USID so Default-Start can set context proactively when the toolkit
    // reloads the page after a preview settings change
    session.privacy.headlessPreviewUSID = token.usid;

    var result = helpers.copyRequestContextToShopperContext(token.usid);
    if (!result.ok) {
        sendJSON(502, { error: result.error });
        return;
    }

    sendJSON(200, { success: true, usid: token.usid, context: result.context });
}

SetContext.public = true;
exports.SetContext = SetContext;
