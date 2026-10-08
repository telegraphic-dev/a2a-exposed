# a2a-over-webhook (deprecated: now a2a-exposed)

This package was renamed to [`a2a-exposed`](https://www.npmjs.com/package/a2a-exposed) ([repository](https://github.com/telegraphic-dev/a2a-exposed)).

```bash
npm rm -g a2a-over-webhook && npm i -g a2a-exposed@latest
a2a-exposed --help
```

This alias depends on `a2a-exposed` at the same version and keeps the old `a2a-over-webhook` command (and `npx a2a-over-webhook ...` in existing wake hints) working, with a notice on stderr (`A2A_NO_RENAME_NOTICE=1` silences it). Same commands, same config: an existing `~/.config/a2a-over-webhook` keeps being used. It will be removed in a future minor release.
