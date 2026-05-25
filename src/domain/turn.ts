/**
 * Turn — value object representing a completed user turn.
 *
 * Built from eager.turn + user.message + turn.end events.
 */

export interface Turn {
    id: number;
    messageId: string;
    text: string;
    confidence: number;
    language?: string;
    probability: number;
    latencyMs: number;
}
