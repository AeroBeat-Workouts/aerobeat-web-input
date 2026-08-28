// @ts-check

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const inputRoot = new URL("../", import.meta.url).pathname;
const contractsRoot = new URL("../../aerobeat-web-contracts/", import.meta.url).pathname;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": mime[".html"] });
      response.end(`<!doctype html><html><body><output id="result">pending</output><script type="importmap">{"imports":{"@aerobeat/web-contracts":"/contracts/src/index.js"}}</script><script type="module">
        import { createAeroBodyGridService } from "/input/src/index.js";
        const names = ["nose","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist"];
        const points = {nose:[.5,.3],left_shoulder:[.6,.4],right_shoulder:[.4,.4],left_elbow:[.7,.4],right_elbow:[.3,.4],left_wrist:[.8,.4],right_wrist:[.2,.4]};
        const service = createAeroBodyGridService({calibrationIdPrefix:"browser"});
        for (let timestampMs = 0; timestampMs <= 4000; timestampMs += 250) service.processPoseSample({sourceId:"browser-camera",timestampMs,mirrored:true,landmarks:names.map(name=>({name,x:points[name][0],y:points[name][1],confidence:.95}))});
        const snapshot = service.getSnapshot();
        document.querySelector("#result").textContent = JSON.stringify({id:snapshot.calibration.calibrationId,state:snapshot.calibration.state,frozen:Object.isFrozen(snapshot),grid:snapshot.calibration.grid.id});
      </script></body></html>`);
      return;
    }
    const prefix = url.pathname.startsWith("/contracts/") ? "/contracts/" : "/input/";
    const root = prefix === "/contracts/" ? contractsRoot : inputRoot;
    const relative = normalize(url.pathname.slice(prefix.length)).replace(/^\.\.(?:\/|\\)/u, "");
    const body = await readFile(join(root, relative));
    response.writeHead(200, { "content-type": mime[extname(relative)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Browser server did not bind a TCP port.");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => document.querySelector("#result")?.textContent !== "pending");
  const result = JSON.parse(await page.locator("#result").textContent() ?? "{}");
  assert.deepEqual(result, { id: "browser-1", state: "cooldown", frozen: true, grid: "athlete_body_4x3" });
  assert.deepEqual(consoleErrors, []);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
}
console.log("Browser calibrated body-grid smoke passed.");
