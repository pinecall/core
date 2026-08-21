import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@pinecall/react-theme";
import "@pinecall/react-theme/styles.css";
import "./console.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ThemeProvider defaultTheme="dark">
            <App />
        </ThemeProvider>
    </StrictMode>,
);
