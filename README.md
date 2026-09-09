# rescued.art Studio (art-tag-scanner)

The capture + review PWA for [rescued.art](https://rescued.art). One app, two modes:

- **Capture** — add the photos of one piece (price tag, the art on a white wall
  close + wide, in a room, signature, the back) and hit *Upload*. Nothing else
  to fill in. Photos go to `api.rescued.art/ingest`; the piece lands
  `published=false`. Optional GPS is sent only to match the nearest Goodwill
  server-side (exact coords stay private). Failed uploads (incl. their photos)
  are kept in `localStorage` and can be retried.
- **Review** — list every piece (drafts first). Open one to see how the local
  vision model (Qwen3 on the AMD box, via the API) **sorted the photos into
  slots and read the tag**: price, found-date, a drafted title, description and
  medium. Correct anything, drag photos between slots, then **Publish**.
  *Re-run model* re-analyses on demand.

The Studio is private. A human-entered password is exchanged for a signed,
seven-day browser session; no long-lived API or social credential is shipped in
the JavaScript. Publishing is separate from social announcement and requires an
explicit checkbox/button in the review screen.

## Endpoints used
`POST /api/admin/login` · `POST /ingest` · `GET /api/admin/pieces` ·
`GET /api/admin/pieces/{token}` ·
`PATCH /api/admin/images/{id}` (role) · `PATCH /api/pieces/{token}` (fields +
publish) · `POST /api/admin/pieces/{token}/reanalyze`. Backend lives at
`/srv/workspaces/rescued-art-api`.

## Deploy
Static. The repaired build is available immediately at
`https://api.rescued.art/studio/`. It is also staged at
`/srv/sites/rescued-scanner` for the Cloudflare Pages project
`rescued-scanner`:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=91ba750b9774217a5d3d2ed7b5a642b5 \
  npx -y wrangler@3 pages deploy /srv/sites/rescued-scanner \
  --project-name rescued-scanner --branch main --commit-dirty=true
```

The reversible date/price token, on-device OCR (Tesseract) and the public
decoder page were retired in favour of the model reading the tag directly.
