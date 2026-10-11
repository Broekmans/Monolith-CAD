// Toolbox: insert DIN fasteners into an assembly via the PropertyManager
import { launch } from './common.mjs';
const T = await launch('assembly');
const { win, W, idle } = T;
const sel = async (i, v) => { await win.locator('.pm-body select').nth(i).selectOption(String(v)); await W(300); };
await T.btn('Toolbox'); await W(400);
await sel(0, 'DIN912'); await sel(1, 'M10'); await sel(2, '40');
console.log('info', (await win.locator('div.pm-info').last().textContent()).slice(0, 120));
await T.ok(); await idle(); await W(500);
await T.btn('Toolbox'); await W(400);
await sel(0, 'DIN934'); console.log('selects', await win.locator('.pm-body select').count(), 'size', await win.locator('.pm-body select').nth(1).inputValue());
await T.ok(); await idle(); await W(500);
await T.btn('Toolbox'); await W(300); await sel(0, 'DIN125'); await T.ok(); await idle(); await W(500);
await T.btn('Toolbox'); await W(300); await sel(0, 'DIN7991'); await sel(1, 'M6'); await T.ok(); await idle(); await W(500);
console.log(await win.evaluate(() => lithApp.doc.doc.components.map((c) => `${c.name} ${JSON.stringify(c.lib)} loaded=${!!c._part && !c._part.err}`).join('\n')));
console.log('json', await win.evaluate(() => JSON.stringify(lithApp.doc.toJSON()).length));
await T.shot('toolbox');
await T.app.close();
