'use strict';

/**
 * HeadlessPreview-SetContext
 *
 * Sets the SCAPI Shopper Context of the shopper identified by the posted SLAS access token
 * to the ECOM context of the *current request*.
 *
 * Safe to expose: the context written is computed here on the server from the current
 * session. Only a storefront toolkit session (authenticated BM user) can carry preview
 * settings like customer groups or a future date. A regular shopper calling this can only
 * copy their own session's context onto their own token.
 *
 * POST application/x-www-form-urlencoded: jwt=<SLAS shopper access token>
 *
 * Bare controller with no SFRA dependency, so it works on any cartridge path.
 */

var helpers = require('*/cartridge/scripts/headless-preview/helpers');

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
