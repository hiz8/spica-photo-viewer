import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { perfMark } from "./utils/perf";
import { installTestHooks } from "./utils/testHooks";

perfMark("app:script_start", {
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
});
installTestHooks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
