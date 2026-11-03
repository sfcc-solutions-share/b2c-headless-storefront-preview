'use strict';

/**
 * Headless storefront preview helpers.
 *
 * Copies the *current ECOM request context* (customer groups, effective date/time and
 * source code -- i.e. whatever the storefront toolkit "Preview" settings have applied to
 * this session) to the SCAPI Shopper Context of a headless shopper (identified by USID).
 *
 * Requires a single service `headless.preview.scapi` whose credential:
 *   - URL: https://{shortCode}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/{orgId}/
 *   - user: SLAS *private* client ID (scopes: sfcc.ts_ext_on_behalf_of sfcc.shopper-context.rw)
 *   - password: SLAS client secret
 */

var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
var StringUtils = require('dw/util/StringUtils');
var Site = require('dw/system/Site');
var System = require('dw/system/System');
var Logger = require('dw/system/Logger').getLogger('headless-preview', 'headless-preview');

var SERVICE_ID = 'headless.preview.scapi';

/**
 * @param {Object} params
 * @returns {string}
 */
function formEncode(params) {
    return Object.keys(params)
        .filter(function (key) {
            return params[key] !== undefined && params[key] !== null;
        })
        .map(function (key) {
            return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
        })
        .join('&');
}

/**
 * Parse the credential URL into the SCAPI host and organization ID
 * @param {string} url
 * @returns {{host: string, orgId: string}}
 */
function parseCredentialURL(url) {
    var match = /^(https:\/\/[^/]+)\/.*organizations\/([^/?]+)/.exec(url);
    if (!match) {
        throw new Error(SERVICE_ID + ' credential URL must be https://{shortCode}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/{orgId}/');
    }
    return { host: match[1], orgId: match[2] };
}

/**
 * Generic SCAPI service. Every call creates a new service instance (as required by the
 * service framework) using the shared credential.
 *
 * params:
 *   - path: path relative to the SCAPI host (when using bearer) or relative to the SLAS org URL
 *   - method
 *   - form: (SLAS calls) form params, sent with basic auth from the credential
 *   - token + body: (Shopper API calls) bearer auth and JSON body
 *
 * @returns {dw.svc.HTTPService}
 */
function createService() {
    return LocalServiceRegistry.createService(SERVICE_ID, {
        createRequest: function (svc, params) {
            var cfg = parseCredentialURL(svc.configuration.credential.URL);
            svc.setRequestMethod(params.method || 'POST');

            if (params.form) {
                // SLAS endpoint; credential user/password are sent as HTTP Basic auth
                svc.setURL(cfg.host + '/shopper/auth/v1/organizations/' + cfg.orgId + '/' + params.path);
                svc.addHeader('Content-Type', 'application/x-www-form-urlencoded');
                return formEncode(params.form);
            }

            svc.setAuthentication('NONE');
            svc.setURL(cfg.host + '/' + params.path.replace('{orgId}', cfg.orgId));
            svc.addHeader('Authorization', 'Bearer ' + params.token);
            if (params.body) {
                svc.addHeader('Content-Type', 'application/json');
                return JSON.stringify(params.body);
            }
            return null;
        },
        parseResponse: function (svc, client) {
            return client.text ? JSON.parse(client.text) : {};
        },
        filterLogMessage: function (msg) {
            // never log tokens or secrets
            return msg
                .replace(/("?(access_token|refresh_token|id_token|token)"?\s*[:=]\s*"?)[^"&\s,]+/g, '$1***')
                .replace(/(Bearer\s+)[^\s"]+/g, '$1***');
        },
        getRequestLogMessage: function () {
            return null;
        },
        getResponseLogMessage: function () {
            return null;
        }
    });
}

/**
 * @typedef {Object} TokenInspectionResult
 * @property {boolean} valid
 * @property {string} [error]
 * @property {string} [usid]
 * @property {boolean} [isGuest]
 */

/**
 * Validate a shopper JWT (issued by *any* SLAS client of this tenant) with SLAS introspection
 * and extract its USID.
 *
 * @param {string} jwt
 * @returns {TokenInspectionResult}
 */
function inspectShopperToken(jwt) {
    var result = createService().call({
        path: 'oauth2/introspect',
        form: { token: jwt, token_type_hint: 'access_token' }
    });

    if (!result.ok || !result.object || result.object.active !== true) {
        return { valid: false, error: 'Invalid or expired shopper token' };
    }

    try {
        var payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4) {
            payload += '=';
        }
        var claims = JSON.parse(StringUtils.decodeBase64(payload));
        // sub: cc-slas::{tenant}::scid:{clientId}::usid:{usid}
        var usidPart = claims.sub.split('::').filter(function (p) { return p.indexOf('usid:') === 0; })[0];
        // isb: uido:ecom::upn:Guest::uidn:Guest User::gcid:xxx::chid:SiteID
        var isGuest = (claims.isb || '').indexOf('upn:Guest') !== -1;

        if (!usidPart) {
            return { valid: false, error: 'No USID in token' };
        }
        // require the channel claim (don't skip the check if it's missing)
        if (!claims.isb || claims.isb.split('::').indexOf('chid:' + Site.current.ID) === -1) {
            return { valid: false, error: 'Token was not issued for site ' + Site.current.ID };
        }
        // TSOB is requested with login_id=guest; don't touch registered shoppers' contexts
        if (!isGuest) {
            return { valid: false, error: 'Only guest shopper tokens are supported' };
        }

        return { valid: true, usid: usidPart.replace('usid:', ''), isGuest: isGuest };
    } catch (e) {
        return { valid: false, error: 'Unable to parse token' };
    }
}

/**
 * Feature toggles (site preferences, group "Headless Preview") deciding whether preview
 * context may be copied for the current request. Used by both Default-Start (wrapper) and
 * HeadlessPreview-SetContext.
 *
 *   headlessPreviewAllowProduction (default false): allow on production instances
 *   headlessPreviewRequireBMSession (default true): require a Business Manager user session
 *     (`session.userAuthenticated`, true in the storefront toolkit)
 *
 * @returns {{allowed: boolean, reason?: string}}
 */
function checkPreviewAllowed() {
    var prefs = Site.current;
    if (System.instanceType === System.PRODUCTION_SYSTEM && prefs.getCustomPreferenceValue('headlessPreviewAllowProduction') !== true) {
        return { allowed: false, reason: 'Headless preview is disabled on production instances' };
    }
    // treat unset (null) as true: secure by default
    if (prefs.getCustomPreferenceValue('headlessPreviewRequireBMSession') !== false && !session.userAuthenticated) {
        return { allowed: false, reason: 'A Business Manager session is required' };
    }
    return { allowed: true };
}

/**
 * The ECOM context of the current request. In a storefront toolkit session this reflects
 * the "Preview" settings (customer groups, date/time, source code).
 *
 * @returns {Object} shopper context body
 */
function getCurrentRequestContext() {
    var customerGroupIds = customer.customerGroups.toArray().map(function (group) {
        return group.ID;
    });

    // SCAPI does not accept fractional seconds
    var effectiveDateTime = Site.current.calendar.time.toISOString().replace(/\.\d+Z$/, 'Z');
    var sourceCode = session.sourceCodeInfo ? session.sourceCodeInfo.code : undefined;

    return {
        customerGroupIds: customerGroupIds,
        effectiveDateTime: effectiveDateTime,
        sourceCode: sourceCode
    };
}

/**
 * Set the shopper context of the given USID to the ECOM context of the current request.
 *
 * Only call this with a USID that came from a validated token (see inspectShopperToken).
 *
 * @param {string} usid
 * @returns {{ok: boolean, error?: string, context?: Object}}
 */
function copyRequestContextToShopperContext(usid) {
    var siteId = Site.current.ID;

    // 1. TSOB token on behalf of the (guest) shopper session identified by USID
    var tsob = createService().call({
        path: 'oauth2/trusted-system/token',
        form: {
            grant_type: 'client_credentials',
            hint: 'ts_ext_on_behalf_of',
            idp_origin: 'ecom',
            login_id: 'guest',
            channel_id: siteId,
            usid: usid
        }
    });

    if (!tsob.ok) {
        Logger.error('TSOB token request failed: {0} {1}', tsob.error, tsob.errorMessage);
        return { ok: false, error: 'Error getting TSOB token' };
    }

    // 2. PUT shopper context for the USID
    var context = getCurrentRequestContext();
    var put = createService().call({
        path: 'shopper/shopper-context/v1/organizations/{orgId}/shopper-context/' + usid + '?siteId=' + siteId,
        method: 'PUT',
        token: tsob.object.access_token,
        body: context
    });

    if (!put.ok) {
        Logger.error('Set shopper context failed: {0} {1}', put.error, put.errorMessage);
        return { ok: false, error: 'Error setting shopper context' };
    }

    return { ok: true, context: context };
}

module.exports = {
    checkPreviewAllowed: checkPreviewAllowed,
    inspectShopperToken: inspectShopperToken,
    getCurrentRequestContext: getCurrentRequestContext,
    copyRequestContextToShopperContext: copyRequestContextToShopperContext
};
