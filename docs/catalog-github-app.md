# Llavero-managed catalog reads

The GMAC manager uses a private Cloudflare service binding named `LLAVERO_CATALOG` to the `AppflareCatalog` entrypoint on the production `llavero-web` Worker. Llavero's registry defines the GitHub App as `appflare-catalog-github-app`. Its private key is non-deliverable.

Start **Create GitHub App** on the credential in Llavero. Sign in to GitHub as `gmackie` and confirm the registration. GitHub's callback sends the App ID and key directly into Llavero custody. Install the App with read-only Contents on `gmackie/appflare` (repository ID `1469481130`). Llavero discovers that installation and pins each one-hour token to that repository. [Llavero credential](https://keys.gmac.io/credentials/appflare-catalog-github-app)

Appflare uses the binding to look up release tags and assets in the public Appflare and GMAC catalogs. Llavero makes the authenticated GitHub requests and renews installation tokens. Appflare follows the resulting storage redirects and verifies signed manifests and artifact hashes. Public downloads also work before the credential has been registered and installed.
