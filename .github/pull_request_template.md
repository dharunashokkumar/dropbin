## What this changes

<!-- One change per PR. What, and why. -->

## How it was verified

<!-- There is no test suite; say what you actually ran. -->

```sh

```

## Checklist

- [ ] `node --check src/*.js cli/src/*.js` and `bash -n src/drop.sh` pass
- [ ] `npx wrangler deploy --dry-run --outdir dist` bundles
- [ ] Tried against `npm run dev` with `DROP_HOST=http://127.0.0.1:8787`
- [ ] Any new prompt exits at end of input instead of redrawing (`< /dev/null`)
- [ ] **`CLAUDE.md` and `README.md` updated in this same PR** if routes, the
      two-option shape, the `?info=1` format or a limit changed
- [ ] Still no listing, no server-side zip, no new runtime dependency
