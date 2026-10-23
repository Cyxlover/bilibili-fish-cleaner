// 测试用：加载扩展的普通脚本源码。
//
// 扩展的内容脚本必须是「普通脚本」（MV3 content script 不支持 ES module），
// 所以 src/ 下的文件通过 IIFE 向 globalThis.DSHCC 注册。Node 的 import()
// 可以执行同样的普通脚本文件，副作用即完成注册。

const ROOT = new URL('../../', import.meta.url);

export async function loadExtension(...sourceFiles) {
  for (const file of sourceFiles) {
    await import(new URL(file, ROOT).href);
  }
  return globalThis.DSHCC;
}
