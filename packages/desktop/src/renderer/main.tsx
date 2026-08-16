import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/syntax-highlight.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("missing #root element");
}

createRoot(container).render(<App />);
