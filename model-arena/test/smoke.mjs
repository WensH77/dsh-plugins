// Smoke test for the model-arena node half: settings registration (links +
// persona persistence) and the system-prompt/assemble role injection.
// Run: node test/smoke.mjs
import { apply } from "../lib/index.js";

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  ok  " + label);
  } else {
    failed += 1;
    console.log(" FAIL " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}

check("apply exported", typeof apply === "function");
let threw = null;
try {
  apply({ inject: () => {}, logger: { warn: () => {} } });
} catch (error) {
  threw = error;
}
check("apply runs without throwing", threw === null, String(threw));
// Settings namespace registration surface (linkage persistence)
import * as mod from "../lib/index.js";
check("plugin exports", ["Config", "apply", "inject", "name"].every((k) => k in mod), Object.keys(mod).join(","));
check("Config schema has links", mod.Config !== void 0 && mod.Config.toString().includes("links"));

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exit(failed === 0 ? 0 : 1);
