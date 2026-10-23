// 内容脚本按经典脚本顺序执行：依赖必须先于使用它的文件加载。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const scripts = manifest.content_scripts[0].js;

describe('manifest：内容脚本顺序', () => {
  it('自动清除依赖全部在 main.js 之前', () => {
    const required = [
      'src/lib/engine-bundle.js',
      'src/lib/purge-settings.js',
      'src/lib/purge-strength.js',
      'src/lib/purge-state.js',
      'src/lib/purge-state-store.js',
      'src/lib/purge-marker.js',
      'src/lib/purge-records.js',
      'src/lib/purge-controller.js',
      'src/lib/profile-client.js',
      'src/ui/manual-actions.js',
      'src/lib/message-bridge.js',
    ];
    for (const file of required) {
      assert.ok(scripts.includes(file), `缺少 ${file}`);
      assert.ok(scripts.indexOf(file) < scripts.indexOf('src/content/main.js'), `${file} 必须在 main.js 之前`);
    }
  });

  it('基础适配层与引擎先于控制器，徽标与主脚本最后', () => {
    assert.ok(scripts.indexOf('src/lib/page-adapter.js') < scripts.indexOf('src/lib/purge-controller.js'));
    assert.ok(scripts.indexOf('src/lib/engine-bundle.js') < scripts.indexOf('src/lib/purge-controller.js'));
    // 强度的读写独立成模块，控制器要用它给的档位：必须夹在开关与控制器之间。
    assert.ok(scripts.indexOf('src/lib/purge-settings.js') < scripts.indexOf('src/lib/purge-strength.js'));
    assert.ok(scripts.indexOf('src/lib/purge-strength.js') < scripts.indexOf('src/lib/purge-controller.js'));
    assert.equal(scripts[scripts.length - 1], 'src/content/main.js');
    assert.equal(scripts[scripts.length - 2], 'src/lib/message-bridge.js');
    assert.equal(scripts[scripts.length - 3], 'src/ui/manual-actions.js');
    assert.equal(scripts[scripts.length - 4], 'src/ui/badge.js');
    assert.ok(scripts.indexOf('src/ui/badge.js') < scripts.indexOf('src/ui/manual-actions.js'));
  });

  it('description 不再声称只观测', () => {
    assert.doesNotMatch(manifest.description, /只观测/);
  });

  // 简介按需读取由 Service Worker 用 fetch 代表扩展去取，必须显式声明那一个域名。
  it('取资料只申请一个域名，不附带别的站点权限', () => {
    assert.deepEqual(manifest.host_permissions, ['https://api.bilibili.com/*']);
    for (const pattern of manifest.host_permissions) {
      assert.ok(
        pattern.startsWith('https://api.bilibili.com/'),
        `不该申请 ${pattern}`,
      );
    }
    assert.deepEqual(manifest.permissions, ['sidePanel', 'storage']);
  });
});
