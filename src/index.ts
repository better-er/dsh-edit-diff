/**
 * 主机端：空操作 Cordis 插件。
 * 所有行为在浏览器端 lib/client.js，通过 package.json dsh.client 声明被 web 客户端模块系统发现。
 * 本半身存在是为了让插件根目录成为完整的双面包，在宿主 Loader 中显示为一个条目。
 * 通过 dsh.bundle 成为自挂载 bundle 层，一条 dsh plugin --profile web add 即可完整激活。
 */
/** 插件名，即配置条目 id。 */
const name = "dsh-edit-diff";
/** 不使用任何主机端服务。 */
const inject: string[] = [];
/** 本浏览器端插件无主机端行为。 */
function apply() {}
export { apply, inject, name };
