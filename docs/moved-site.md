# The old address's page (`moved-site/`)

What `https://liquiditymapperfast.github.io/` served from 2026-11-14, when the site moved to `https://liquiditymapper.com/`, until
2026-11-21, when the repository moved from `liquiditymapperfast` to `Karlheinzniebuhr`. It is not part of the page's build:
`.github/workflows/pages.yml` published this folder as it is to GitHub Pages while the repository belonged to `liquiditymapperfast` (its
`deploy` job skips under any other owner), while the built page goes to Cloudflare. The transfer retired the repository's old name, as
GitHub does when a repository had over 100 clones in the week before (2,654 in the week to 2026-11-20), so the old address answers
"Site not found" now and can never be published again; links to the repository itself redirect.

- `index.html` and `404.html` (the same file) sent every visit on: the root to the new root with what the browser saved on the old
  address in the fragment (taken once by `src/app/handover.ts`), any other path to the same path there. An installed copy of the app got
  a note to install it again from the new address instead of being sent off.
- `assets/moved-v1a2026.js` does nothing: its name, read as a build's by `src/app/update-check.ts`, made a tab still open on the old
  site offer Reload, which brought it here.
- `.nojekyll` published the files as they are (needed only if the folder were ever published from a branch).

`tests/app-handover.test.mts` runs this page's script against the receiver, so a change to the key rule or the encoding on either side
fails there. Nothing can hand over any more: remove this folder, the workflow's second artifact upload and its `deploy` job, and
`src/app/handover.ts` together (the workflow's comment says why the first three go together). Do it before the `liquiditymapperfast`
account is ever deleted or given up: the receiver trusts a referrer from the old origin, and any repository in that account, or in the
account of whoever took the name later, could publish a page there.
