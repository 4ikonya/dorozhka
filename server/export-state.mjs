#!/usr/bin/env node
// Writes the laptop data (clients, schedule, payments, prices, settings) to data/state-export.json
// for the cloud version's "Перенести данные с ноутбука". The Telegram token is not included.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root, 'data', 'dorozhka.db'), { readOnly: true });
const row = db.prepare('SELECT json FROM state WHERE id = 1').get();
if (!row) {
  console.error('В базе пока нет данных.');
  process.exit(1);
}
const out = path.join(root, 'data', 'state-export.json');
fs.writeFileSync(out, row.json);
const S = JSON.parse(row.json);
console.log(`Сохранено: ${path.relative(root, out)} — клиентов ${S.clients.length}, занятий ${S.sessions.length}, оплат ${S.payments.length}`);
