/**
 * The ONE version string in the SDK.
 *
 * It used to live in four places (cli.ts, cli/ui.ts banner, tap/fetch.ts and
 * package.json) and all four had drifted apart. Everything that shows a
 * version now reads from here.
 *
 * At build time tsup's `define` substitutes `__PKG_VERSION__` with the literal
 * from package.json, so the shipped bundles can never disagree with the
 * manifest — the SDK builds to a bundle with no package.json alongside it, so
 * importing the manifest at runtime is not an option. The literal below is the
 * fallback for anything that runs the TypeScript directly (vitest, tsx); it is
 * kept honest by `npm run check:version`, which `prepublishOnly` runs.
 */

declare const __PKG_VERSION__: string;

export const VERSION: string =
    typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.12.1";
