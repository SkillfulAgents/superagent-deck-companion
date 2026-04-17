import { handleFatalError, startCompanionApp } from "./core/app.js";

startCompanionApp().catch(handleFatalError);
