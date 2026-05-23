import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite plugin that boots the Pinecall agent on dev server start
function pinecallAgent() {
  return {
    name: "pinecall-agent",
    async configureServer() {
      const { startAgent } = await import("./agent.js");
      await startAgent();
    },
  };
}

export default defineConfig({
  plugins: [react(), pinecallAgent()],
});
