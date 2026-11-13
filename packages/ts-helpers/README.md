# ts-helpers

Small TypeScript helpers shared by the Pi extensions in this repository.

- `ts-helpers/display-path` — shorten paths for display: relative to a working directory when given, otherwise `~` for the home directory.
- `ts-helpers/tool-status` — format tool result headings (bold, colored by status) the same way in every extension.

## Development

```sh
pnpm run check
pnpm run test
```
