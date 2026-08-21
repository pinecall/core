/**
 * RESEARCH SPIKE — 03b: variant A+H — option A plus ONE deterministic extra:
 * put the page title back as an H1 at the top of the body. Defuddle moves the
 * <h1> into metadata, so every tapped doc today starts headless and the
 * heading-aligned chunker's first chunk carries no heading. No LLM.
 *
 *   node scripts/research/03b-option-a-heading.mjs <site>…
 */
import { readVariant, writeVariant } from "./lib.mjs";
for (const site of process.argv.slice(2)) {
    const A = readVariant(site, "A");
    const docs = A.docs.map((d) => {
        if (d.path === "_tap-manifest.json") return d;
        const m = d.text.match(/^---[\s\S]*?---\n\n/);
        const fm = m ? m[0] : "";
        const body = d.text.slice(fm.length);
        if (/^#\s/.test(body)) return d;
        return { ...d, text: `${fm}# ${d.title}\n\n${body}` };
    });
    writeVariant(site, "A+H", docs, { base: "A" });
    console.log(`${site}: A+H written (${docs.length} docs)`);
}
