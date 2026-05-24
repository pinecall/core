import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite plugin — boots the Pinecall agent and serves a token endpoint.
 *
 * GET /api/token → generates a short-lived WebRTC token via agent.createToken().
 * This keeps the API key server-side. The frontend calls this endpoint
 * via the VoiceWidget's `tokenProvider` prop.
 */
function pinecallAgent() {
  let agentRef = null;

  return {
    name: "pinecall-agent",
    async configureServer(server) {
      const { startAgent } = await import("./agent.js");
      const result = await startAgent();
      agentRef = result?.agent ?? null;

      // Token endpoint — frontend calls this instead of /webrtc/token directly
      server.middlewares.use("/api/token", async (req, res) => {
        if (!agentRef) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Agent not ready" }));
          return;
        }
        try {
          const token = await agentRef.createToken("webrtc");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(token));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pinecallAgent()],
});
