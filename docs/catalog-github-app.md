# GitHub App for catalog reads

This fork's manager uses a dedicated GitHub App to fetch releases from the public Appflare and GMAC catalogs. It resolves release tags through GitHub's REST API, fetches manifests, signatures, and archive ranges by asset ID, and verifies artifacts with Appflare's existing signing keys. When the App bindings are absent, the manager uses the public catalog download URLs.

1. Register a private GitHub App with **Contents → Read-only**. Disable webhooks. Install it on the manager fork and record the numeric App ID and installation ID. [GitHub registration](https://github.com/settings/apps/new?name=gmackie-appflare-catalog-reader&url=https%3A%2F%2Fapps.gmac.io&public=false&webhook_active=false&contents=read)
2. Generate a private key under the App's settings. Store the downloaded PEM in the owner's personal Llavero store as `appflare-github-app-private-key`.
3. Configure the manager Worker's `CATALOG_GITHUB_APP_ID` and `CATALOG_GITHUB_INSTALLATION_ID` bindings with those IDs. Deliver the PEM as the encrypted Worker secret `CATALOG_GITHUB_PRIVATE_KEY`, preserving its line breaks. Apply the three bindings together.
4. Open a previously uncached catalog entry. A successful load verifies the signed manifest, and the manager caches that version by digest. The install job independently verifies the artifact before deploying.

GitHub issues the installation token for one hour. The manager requests read-only Contents permission, reuses the token in memory, and renews it before expiry. It sends the credential to GitHub's API and follows asset-storage redirects without it. GitHub's primary REST quota applies to authenticated calls. Secondary rate limits can still apply.

To rotate the signing key, generate another key on the same App, replace the PEM in Llavero, and deliver the new Worker secret before retiring the old GitHub key.
