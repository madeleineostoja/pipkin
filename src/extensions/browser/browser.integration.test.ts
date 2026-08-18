import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "./act.js";
import { observe } from "./observe.js";
import { BrowserOwner } from "./owner.js";

const owners: BrowserOwner[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
});

describe("Browser integration", () => {
  it.skipIf(process.env.PIPKIN_BROWSER_INTEGRATION !== "1")(
    "owns a lazy loopback session and returns bounded rendered evidence",
    async () => {
      const server = createServer((request, response) => {
        if (request.url === "/missing") {
          response.statusCode = 404;
          response.end("missing");
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(`
          <main><button aria-label="Save">Save</button><p style="color: rgb(1, 2, 3)">Rendered</p></main>
          <script>
            console.warn("fixture warning");
            fetch("/missing"); fetch("http://127.0.0.1:1/no-server").catch(() => {});
            setTimeout(() => { throw new Error("fixture page error") });
          </script>`);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const owner = new BrowserOwner();
      owners.push(owner);
      try {
        const action = await owner.run(undefined, () =>
          act(owner, { action: "navigate", url }),
        );
        expect(action.details.activeTabId).toBe("tab-1");
        const snapshot = await owner.run(undefined, () =>
          observe(owner, { mode: "snapshot" }),
        );
        const snapshotText = (snapshot.content[0] as { text: string }).text;
        const ref = /\[ref=([^\]]+)\]/.exec(snapshotText)?.[1];
        expect(ref).toBeTruthy();
        const refText = await owner.run(undefined, () =>
          observe(owner, {
            mode: "text",
            target: { kind: "ref", value: ref! },
          }),
        );
        expect(refText.content[0]).toMatchObject({
          text: expect.stringContaining("Save"),
        });
        const element = await owner.run(undefined, () =>
          observe(owner, {
            mode: "element",
            target: { kind: "role", value: "button", name: "Save" },
            styleProperties: ["color"],
          }),
        );
        expect(element.details).toMatchObject({
          visible: true,
          styles: { color: expect.any(String) },
        });
        await owner.run(undefined, () =>
          act(owner, { action: "set_viewport", width: 800, height: 600 }),
        );
        const viewportImage = await owner.run(undefined, () =>
          observe(owner, { mode: "screenshot" }),
        );
        const elementImage = await owner.run(undefined, () =>
          observe(owner, {
            mode: "screenshot",
            target: { kind: "role", value: "button", name: "Save" },
          }),
        );
        for (const image of [viewportImage, elementImage]) {
          expect(image.content[1]).toMatchObject({
            type: "image",
            mimeType: "image/png",
          });
        }
        const opened = await owner.run(undefined, () =>
          act(owner, { action: "open_tab" }),
        );
        expect(opened.details.activeTabId).toBe("tab-2");
        await owner.run(undefined, () =>
          act(owner, { action: "switch_tab", tabId: "tab-1" }),
        );
        const diagnostics = await owner.run(undefined, () =>
          observe(owner, { mode: "diagnostics" }),
        );
        expect(diagnostics.content[0]).toMatchObject({
          text: expect.stringContaining("fixture warning"),
        });
        expect((diagnostics.content[0] as { text: string }).text).toContain(
          "http_error",
        );
        expect((diagnostics.content[0] as { text: string }).text).toContain(
          "request_failed",
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    30_000,
  );
});
