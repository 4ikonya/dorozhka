// The app's inline script must parse (the check from CLAUDE.md, run with the other tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../dorozhka.html', import.meta.url), 'utf8');

test('dorozhka.html: скрипт без синтаксических ошибок', () => {
  const scripts = [...html.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
});
