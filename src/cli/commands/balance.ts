/**
 * CLI — `pinecall balance`
 *
 * Shows Twilio account balance.
 * Uses GET /api/sdk/twilio-balance.
 */

import type { CliConfig } from "../config.js";
import { c, info, error } from "../ui.js";

interface BalanceResponse {
    success: boolean;
    balance: string;
    currency: string;
    error?: string;
}

export async function balanceCommand(config: CliConfig): Promise<void> {
    const url = `${config.server}/api/sdk/twilio-balance`;
    let res: Response;

    try {
        res = await fetch(url, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
        });
    } catch {
        error(`Cannot reach server at ${config.server}`);
    }

    if (!res!.ok) {
        error(`Failed to fetch balance: ${res!.status}`);
    }

    const data: BalanceResponse = await res!.json();

    if (config.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    if (!data.success) {
        error(data.error ?? "Failed to fetch balance");
    }

    const amount = parseFloat(data.balance).toFixed(2);
    const color = parseFloat(data.balance) < 10 ? c.red : c.green;
    info(`Twilio Balance: ${color(`$${amount}`)} ${c.dim(data.currency)}`);
}
