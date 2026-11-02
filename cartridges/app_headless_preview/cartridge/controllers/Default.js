'use strict';

/**
 * Default-Start: entry point used by Business Manager's "Storefront" button and by the
 * Storefront Toolkit (preview).
 *
 * If the site preference `headlessPreviewURL` is configured:
 *   - inside the storefront toolkit: render a wrapper page that iframes the headless app and
 *     syncs the toolkit's preview context (customer groups, date/time, source code) to the
 *     headless shopper's SCAPI Shopper Context
 *   - otherwise (and `headlessPreviewRedirect` is true): redirect to the headless app
 *
 * Works as a *bare* controller (no SFRA / `modules` cartridge required). When SFRA's
 * `server` module is available the controller extends the next Default.js in the cartridge
 * path using `server.extend(module.superModule)`.
 */

var Site = require('dw/system/Site');
var URLUtils = require('dw/web/URLUtils');

/**
 * Decide what (if anything) this cartridge should do for the current request.
 * @returns {{action: string, previewURL?: string}}
 */
function resolveAction() {
    var previewURL = Site.current.getCustomPreferenceValue('headlessPreviewURL');
    if (!previewURL) {
        return { action: 'none' };
    }

    // The storefront toolkit adds this parameter when it loads/reloads the storefront
    var inToolkit = request.httpParameterMap.__sftkCacheBuster.submitted;

    if (inToolkit) {
        return { action: 'preview', previewURL: previewURL };
    }
    if (Site.current.getCustomPreferenceValue('headlessPreviewRedirect')) {
        return { action: 'redirect', previewURL: previewURL };
    }
    return { action: 'none' };
}

/**
 * Proactively update the context of the last previewed headless shopper so the headless app
 * renders with the new preview settings when the toolkit reloads the page.
 *
 * @returns {Object} template data
 */
function preparePreview(previewURL) {
    var helpers = require('*/cartridge/scripts/headless-preview/helpers');
    var contextResult = null;

    if (session.privacy.headlessPreviewUSID) {
        contextResult = helpers.copyRequestContextToShopperContext(session.privacy.headlessPreviewUSID);
    }

    return {
        previewURL: previewURL,
        setContextEndpoint: URLUtils.https('HeadlessPreview-SetContext').toString(),
        // context of this ECOM request (what the toolkit preview settings resolve to)
        previewContext: JSON.stringify(helpers.getCurrentRequestContext()),
        proactiveContextSet: !!(contextResult && contextResult.ok)
    };
}

var server = null;
try {
    server = require('server');
} catch (e) {
    // SFRA `modules` cartridge not in the cartridge path: bare controller mode
}

if (server && module.superModule && module.superModule.__routes) {
    /* ---------- SFRA mode ---------- */
    server.extend(module.superModule);

    // Keep the original Start middleware chain so non-preview requests behave exactly
    // as they did before this cartridge was added
    var baseStart = server.getRoute('Start');
    var baseChain = baseStart ? baseStart.chain.slice() : [];

    var start = function (req, res, next) {
        var resolved = resolveAction();
        if (resolved.action === 'preview') {
            res.render('headlesspreview/wrapper', preparePreview(resolved.previewURL));
            return next();
        }
        if (resolved.action === 'redirect') {
            res.redirect(resolved.previewURL);
            return next();
        }

        // fall through to the original Default-Start chain
        var route = this;
        var i = 0;
        (function step(err) {
            if (err || res.redirectUrl || i >= baseChain.length) {
                return next(err);
            }
            return baseChain[i++].call(route, req, res, step);
        })();
        return undefined;
    };

    if (baseStart) {
        server.replace('Start', start);
    } else {
        server.get('Start', start);
    }

    module.exports = server.exports();
} else {
    /* ---------- Bare controller mode ---------- */
    var ISML = require('dw/template/ISML');

    // Re-export anything else the next Default.js in the path provides (if it can be loaded
    // without SFRA). Our Start always wins.
    try {
        var base = module.superModule;
        if (base) {
            Object.keys(base).forEach(function (key) {
                exports[key] = base[key];
            });
        }
    } catch (e) {
        // superModule is an SFRA controller that cannot load without `server`; ignore
    }

    var baseStart = exports.Start;

    /** Default-Start */
    exports.Start = function Start() {
        var resolved = resolveAction();
        if (resolved.action === 'preview') {
            ISML.renderTemplate('headlesspreview/wrapper', preparePreview(resolved.previewURL));
        } else if (resolved.action === 'redirect') {
            response.redirect(resolved.previewURL);
        } else if (baseStart) {
            baseStart.apply(this, arguments);
        } else {
            response.setStatus(404);
            response.writer.print('This site is headless.');
        }
    };
    exports.Start.public = true;
}
