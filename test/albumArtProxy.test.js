const assert = require("node:assert/strict");
const test = require("node:test");
const { AlbumArtProxy, isUsablePublicBaseUrl } = require("../src/albumArtProxy");

test("album art proxy requires a public base URL", () => {
  assert.equal(isUsablePublicBaseUrl(""), false);
  assert.equal(isUsablePublicBaseUrl("not-a-url"), false);
  assert.equal(isUsablePublicBaseUrl("https://example.com"), true);
});

test("album art proxy returns stable public URLs without fetching immediately", () => {
  let fetchCount = 0;
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "https://roon-art.example.com/",
    fetchImage: async () => {
      fetchCount += 1;
      return Buffer.from("image");
    }
  });

  const first = proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc");
  const second = proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc");

  assert.equal(first, second);
  assert.match(first, /^https:\/\/roon-art\.example\.com\/art\/[a-f0-9]{40}\.jpg$/);
  assert.equal(fetchCount, 0);
});

test("album art proxy returns empty URL when no public base URL is configured", () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: ""
  });

  assert.equal(proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc"), "");
});

test("album art proxy reloads public URL config", () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "",
    port: 8787
  });

  assert.equal(
    proxy.updateConfig({
      publicBaseUrl: "https://roon-art.example.com",
      port: 8787,
      cacheMax: 40
    }),
    true
  );
  assert.equal(
    proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc").startsWith("https://roon-art.example.com/art/"),
    true
  );
  proxy.stop();
});
