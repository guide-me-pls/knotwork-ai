import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { uiStringKeys, uiStrings } from "../src/desktop/ui-locale.ts";

test("English and Chinese chrome tables cover the same keys", () => {
  const keys = uiStringKeys();
  const zh = uiStrings("zh-CN");
  const en = uiStrings("en");
  assert.ok(keys.length > 40);
  for (const key of keys) {
    assert.equal(typeof zh[key], "string", `zh-CN missing ${key}`);
    assert.equal(typeof en[key], "string", `en missing ${key}`);
    assert.ok(zh[key].length > 0, `zh-CN empty ${key}`);
    assert.ok(en[key].length > 0, `en empty ${key}`);
  }
  assert.equal(zh["new-session"], "新建任务");
  assert.equal(en["new-session"], "New task");
});

test("the desktop HTML marks chrome so config.locale can replace it", async () => {
  const html = await readFile(join(process.cwd(), "apps/desktop/ui/index.html"), "utf8");
  assert.match(html, /data-i18n="new-session"/);
  assert.match(html, /id="config-locale"/);
  const js = await readFile(join(process.cwd(), "apps/desktop/ui/app.js"), "utf8");
  assert.match(js, /function applyChrome/);
  assert.match(js, /config\.ui\?\.strings/);
});
