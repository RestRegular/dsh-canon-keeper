/**
 * 测试用加载器钩子：把宿主的 `@deepseek-ai/dsh-tools` 换成本地 stub。
 *
 * index.js 是宿主侧入口，`import { defineTool } from '@deepseek-ai/dsh-tools'`
 * 只在 DSH 进程里能解析。离线测试要验证 Config 描述符与工具注册接线，
 * 就只 stub 这一个函数 —— 它本身在宿主里也只是「给定义加个身份」，
 * 真正需要验证的是我们喂给它的定义长什么样。
 *
 * 用法：node --import ./test/register-stub.mjs test/host.mjs
 *
 * @module dsh-canon-keeper/test/register-stub
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const stubUrl = pathToFileURL(new URL('./stub-tools.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;

const source = `
const STUB = ${JSON.stringify(stubUrl)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(source)}`, pathToFileURL(import.meta.filename).href);
