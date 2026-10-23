// 侧边面板的注册与页面装配：manifest 指向真实文件、脚本按依赖顺序加载。
//
// Edge 侧边面板本身需要浏览器才能打开，这里测的是「点击图标就能打开面板」
// 所依赖的静态接线，避免路径或顺序写错后要手动加载扩展才发现。

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function exists(path) {
  return existsSync(new URL(path, root));
}

describe('manifest：侧边面板接线', () => {
  it('注册了 side_panel 且页面文件真实存在', () => {
    assert.equal(manifest.side_panel.default_path, 'src/sidepanel/sidepanel.html');
    assert.ok(exists(manifest.side_panel.default_path));
  });

  it('具备 sidePanel 与 storage 权限', () => {
    assert.ok(manifest.permissions.includes('sidePanel'));
    assert.ok(manifest.permissions.includes('storage'));
  });

  it('后台服务脚本存在，并让点图标直接开面板', () => {
    assert.equal(manifest.background.service_worker, 'src/background.js');
    assert.ok(exists('src/background.js'));
    const source = read('src/background.js');
    assert.match(source, /setPanelBehavior/);
    assert.match(source, /openPanelOnActionClick:\s*true/);
  });

  it('侧边栏页面按依赖顺序加载脚本', () => {
    const html = read('src/sidepanel/sidepanel.html');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(scripts, [
      '../lib/purge-state.js',
      '../lib/purge-settings.js',
      '../lib/purge-records.js',
      '../lib/purge-state-store.js',
      '../lib/message-bridge.js',
      '../ui/panel.js',
      'sidepanel.js',
    ]);
    for (const script of scripts) {
      assert.ok(exists('src/sidepanel/' + script), `缺少 ${script}`);
    }
  });
});
