import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installTestHooks } from "./utils/testHooks";

installTestHooks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
