# B2C Headless Storefront Preview (Storefront Toolkit → Shopper Context)

A tech demo showing how a **custom headless storefront** (anything not hosted on Managed Runtime / not PWA Kit) can support Business Manager **Storefront Toolkit preview**: customer groups, "shop the future" date/time and source codes.

It's the same approach the [composable-storefront-pocs](https://github.com/SalesforceCommerceCloud/composable-storefront-pocs) storefront toolkit overlay uses for PWA Kit, pulled out on its own:

- `cartridges/app_headless_preview`: an ECOM cartridge. It works as a **bare controller** (no SFRA required) and is also compatible with SFRA (`server.extend(module.superModule)`)
- `demo-server`: a dependency-free Node server and static page standing in for "your headless app". Expose it with a Cloudflare quick tunnel; no permanent hosting is needed

This is a demo, not production code.

## How it works

```mermaid
sequenceDiagram
    participant BM as Storefront Toolkit (BM user session)
    participant ECOM as ECOM: Default-Start / HeadlessPreview-SetContext
    participant App as Headless app (iframe)
    participant SLAS
    participant SCAPI as SCAPI Shopper Context

    BM->>ECOM: Default-Start?__sftkCacheBuster=… (preview settings applied to session)
    ECOM-->>BM: wrapper page with <iframe src=headlessPreviewURL>
    App->>SLAS: normal shopper login (guest) → access token (USID)
    App->>ECOM: postMessage {type: headless-preview:token, token} (via wrapper JS)
    ECOM->>SLAS: introspect token (validate, extract USID, check site)
    ECOM->>SLAS: trusted-system/token (TSOB) for USID
    ECOM->>SCAPI: PUT /shopper-context/{usid} {customerGroupIds, effectiveDateTime, sourceCode}<br/>(taken from the *current ECOM request*)
    ECOM-->>App: postMessage {type: headless-preview:context-set}
    App->>SCAPI: normal Shopper API calls now reflect the preview context
```

Key points:

- **The context is computed on the server from the ECOM session.** The browser never sends context values, only its shopper token. Only a storefront toolkit session (an authenticated BM user) carries preview settings. A regular shopper calling `HeadlessPreview-SetContext` can only copy their own (normal) session context onto their own token.
- **The shopper-context write scope stays server-side.** `sfcc.shopper-context.rw` and `sfcc.ts_ext_on_behalf_of` belong to a dedicated private SLAS client that only the ECOM service uses. The headless app's own client doesn't need them; the demo adds `sfcc.shopper-context` (read) only to display the current context.
- **Changing preview settings reloads the toolkit page.** The cartridge keeps the last USID in `session.privacy`, so `Default-Start` updates the context *before* the iframe loads. When the app sends its token, the wrapper skips the redundant call.
- **No third-party cookies.** The app keeps its token in `sessionStorage`, and messaging uses `postMessage` with origin checks on both sides. PWA Kit, by contrast, needed a `commerce-sdk-react` patch for iframe cookies.

## Contents

```
cartridges/app_headless_preview/cartridge/
  controllers/Default.js           Default-Start: wrapper in toolkit / optional redirect; bare or SFRA
  controllers/HeadlessPreview.js   HeadlessPreview-SetContext (bare controller)
  scripts/headless-preview/helpers.js   introspect, TSOB, PUT shopper context
  templates/default/headlesspreview/wrapper.isml
  static/default/js/headless-preview.js parent side of the postMessage protocol
demo-data/                         optional Big Spenders campaign + 50% off promotion (site archive)
metadata/                          site prefs (HeadlessPreview group) + service definition
scripts/setup.sh                   import metadata/service, deploy, cartridge path, prefs (b2c CLI)
demo-server/                       the "custom headless" storefront
```

### Coexisting with other cartridges

The cartridge only takes over `Default-Start` when `headlessPreviewURL` is set for the site. Use distinct names (`HeadlessPreview-*`, `headlessPreview*` prefs, `headless.preview.scapi` service) so it can sit **first** in a cartridge path that also has `app_composable_toolkit` / `app_q_pwa_support` or SFRA:

- **SFRA available** (`modules` in path): extends the next `Default.js` and replaces only `Start`
- **No SFRA**: exports `Start` directly. If the next `Default.js` can load without SFRA, its other exports are re-exported, and its `Start` is used as the fallback when preview isn't active

## Setup

Requirements: [b2c CLI](https://github.com/SalesforceCommerceCloud/b2c-developer-tooling), Node 20+, `cloudflared`, `jq`.

1. **SLAS clients** (both private, channel = your site):

   ```bash
   # used by ECOM only
   b2c slas client create -i <instance> --channels RefArchGlobal --name "headless-preview: ECOM preview (TSOB)" \
     --scopes sfcc.ts_ext_on_behalf_of,sfcc.shopper-context.rw --redirect-uri http://localhost:3000/callback --json
   # used by the headless app
   b2c slas client create -i <instance> --channels RefArchGlobal --name "headless-preview: demo storefront" \
     --default-scopes --scopes sfcc.shopper-context --redirect-uri http://localhost:3000/callback --json
   ```

2. `cp .env.example .env` and fill in the short code, org ID, and both client IDs/secrets.
3. Start the app and a tunnel:

   ```bash
   cd demo-server && npm start          # http://localhost:3000
   npm run tunnel                       # prints https://<random>.trycloudflare.com
   ```

4. Install on the instance (metadata + service credential, code deploy to the active code version, cartridge first in the site path, preview URL pref):

   ```bash
   ./scripts/setup.sh <instance> https://<random>.trycloudflare.com/
   ```

   Re-run with a new URL whenever the quick tunnel URL changes (or just update **Site Preferences → Custom Preferences → Headless Preview**).

5. In BM, enable **Merchant Tools → Site Preferences → Hybrid Auth Settings → Shopper Context** for the site if it isn't already.

### Demo promotion (optional)

`demo-data/` is a site archive with a `headless-preview-big-spenders` campaign (customer group **Big Spenders**) and a searchable promotion, `headless-preview-big-spenders-50off`, giving 50% off everything in `storefront-catalog-m-non-en`. Run `DEMO_DATA=1 ./scripts/setup.sh <instance>` to import it and rebuild the search index. In the toolkit, set **Preview → Customer Groups → Big Spenders**. The product grid then shows a "Big Spenders: 50% off everything" callout, which is missing without that group.

### Try it

1. BM → select the site → **Storefront** (opens the storefront toolkit)
2. The toolkit loads the wrapper, which iframes the demo app. The badge reads "storefront preview", and both context panels show the same customer groups and date.
3. Open the toolkit **Preview** settings and change the date/time (shop the future), customer groups or source code. The toolkit reloads, the context updates, and SCAPI results (prices/promotions in the product grid) reflect it.

`http://localhost:3000/` also works as the preview URL if the browser running BM is on the same machine. Browsers allow an `https` page to frame `http://localhost`.

## Notes / limitations

- Only guest shoppers (`login_id=guest`) are handled. Registered shoppers would need TSOB with their login.
- Context on non-PRD instances lasts 1 day and has a quota of 5,000 contexts. TSOB has a 3-second per-shopper rate limit (HTTP 409).
- `frame-ancestors` on the demo app only allows `*.dx.commercecloud.salesforce.com` and `*.demandware.net` (`PREVIEW_PARENT_HOSTS`), and the app only talks to a parent in that list.
- Search, content, and other storefront toolkit tools besides Preview aren't supported.
