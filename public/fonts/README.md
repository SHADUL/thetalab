# Licensed display / body fonts

The design calls for **Söhne** (display, headings) and **GrowwSans** (body).
Neither is bundled: Söhne is a commercial licence from Klim Type Foundry, and
GrowwSans is Groww's in-house typeface. There is no distributable copy of
either, so they cannot ship with this repo.

Both are already named first in the font stacks in `src/index.css`, so nothing
in the code needs to change once you have the files.

To self-host them:

1. Drop the licensed variable `.woff2` files here as:
   - `soehne-variable.woff2`
   - `groww-sans-variable.woff2`
2. Uncomment the `@font-face` block at the top of `src/index.css`.

Until then the stacks fall through to close substitutes, both open licensed:

| Role    | Intended   | Shipping substitute | Why                                                |
|---------|------------|---------------------|----------------------------------------------------|
| Display | Söhne      | Archivo             | Akzidenz-Grotesk descendant — the family Söhne derives from |
| Body    | GrowwSans  | Public Sans         | Neo-grotesque of the same temperature               |
| Numerals| —          | Geist Mono          | Tabular figures, so columns align to the pixel      |

If a viewer has Söhne or GrowwSans installed locally, the stack picks them up
already — no files needed on the server.
