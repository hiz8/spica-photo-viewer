import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");

type PreviewProbe = {
  ok: boolean;
  status: number;
  type: string;
  width: number;
  height: number;
  naturalWidth: string | null;
  naturalHeight: string | null;
  error?: string;
};

/** Fetches a preview in the page and decodes it, so we see what the viewer would see. */
const probePreview = (file: string, box: string): Promise<PreviewProbe> =>
  browser.executeAsync(
    (url: string, done: (r: PreviewProbe) => void) => {
      fetch(url)
        .then(async (r) => {
          const blob = await r.blob();
          const bitmap = r.ok ? await createImageBitmap(blob) : null;
          done({
            ok: r.ok,
            status: r.status,
            type: blob.type,
            width: bitmap?.width ?? 0,
            height: bitmap?.height ?? 0,
            naturalWidth: r.headers.get("X-Spica-Natural-Width"),
            naturalHeight: r.headers.get("X-Spica-Natural-Height"),
          });
          bitmap?.close();
        })
        .catch((e) =>
          done({
            ok: false,
            status: -1,
            type: "",
            width: 0,
            height: 0,
            naturalWidth: null,
            naturalHeight: null,
            error: String(e),
          }),
        );
    },
    `http://spica-img.localhost/preview/${box}/${encodeURIComponent(file)}`,
  ) as unknown as Promise<PreviewProbe>;

describe("preview protocol", () => {
  it("serves a 20MP image fitted into the 1080p box with natural-size headers", async () => {
    const files = readdirSync(join(CORPUS, "large"))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    const probe = await probePreview(
      join(CORPUS, "large", files[0]),
      "1920x1080",
    );
    expect(probe.ok).toBe(true);
    expect(probe.type).toBe("image/jpeg");
    expect([probe.width, probe.height]).toEqual([1620, 1080]); // 5472x3648 → fit 1920x1080
    expect(probe.naturalWidth).toBe("5472");
    expect(probe.naturalHeight).toBe("3648");
  });

  it("applies EXIF orientation to the preview and reports oriented natural size", async () => {
    const probe = await probePreview(
      join(CORPUS, "exif", "img-000.jpg"),
      "1920x1080",
    );
    expect(probe.ok).toBe(true);
    expect([probe.width, probe.height]).toEqual([720, 1080]); // 800x1200 oriented → fit
    expect(probe.naturalWidth).toBe("800");
    expect(probe.naturalHeight).toBe("1200");
  });

  it("rejects unknown boxes and missing files", async () => {
    const files = readdirSync(join(CORPUS, "large"))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    const badBox = await probePreview(
      join(CORPUS, "large", files[0]),
      "1000x1000",
    );
    expect(badBox.status).toBe(404);
    const missing = await probePreview("C:\\nope\\missing.jpg", "1920x1080");
    expect(missing.status).toBe(404);
  });
});
