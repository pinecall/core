/**
 * CLI — `pinecall signup`
 *
 * Opens the Pinecall signup page in the browser.
 */

import type { CliConfig } from "../config.js";
import { c } from "../ui.js";
import { exec } from "child_process";

const SIGNUP_URL = "https://playground.pinecall.io/signup";

export async function signupCommand(_config: CliConfig, _args: string[]): Promise<void> {
    console.log("");
    console.log(`  ${c.purple("⚡")} Opening signup page...`);
    console.log(`  ${c.dim(SIGNUP_URL)}`);
    console.log("");

    // Open in default browser
    const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start"
        : "xdg-open";

    exec(`${cmd} ${SIGNUP_URL}`, (err) => {
        if (err) {
            console.log(`  ${c.dim("Could not open browser. Visit the URL above to sign up.")}`);
        }
    });
}
