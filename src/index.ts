/**
 * 主机端：把本插件的入口配置声明成设置表单，供浏览器端读取解析后的值。
 *
 * 浏览器半身拿不到 cordis 配置：__DSH_BOOT__ 的 entry 不含 config 字段，客户端内核创建插件时也不传 config。
 * 配置字段经 .volatile() 声明后进入设置表单，client 半身用 ctx.configForms.get('dsh-edit-diff') 读解析值。
 *
 * 没有挂载 settings provider 时 configure 不会执行，浏览器端的 edit/write 卡片不受影响，只是 extraTools 不生效。
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

/** 插件名，即配置条目 id。 */
export const name = 'dsh-edit-diff'

/** 设置命名空间，与包名一致，浏览器半身按同名取配置表单。 */
export const NS = 'dsh-edit-diff'

/** 一个额外接管的工具，以及读取其参数用的参数名。 */
export interface ExtraTool {
  /** wire 工具名，即 tool.call.toolview 的 key。 */
  name: string
  /** 读取文件路径的参数名，默认 file_path。 */
  pathKey?: string
  /** 读取旧文本的参数名，默认 old_string。 */
  oldKey?: string
  /** 读取新文本的参数名，默认 new_string。 */
  newKey?: string
  /** 读取整文件内容的参数名，默认 content。 */
  contentKey?: string
}

/** 插件配置。volatile 字段才能在客户端读到解析后的值。 */
export interface Config {
  /** 除 edit 与 write 外，额外接管 diff 卡片显示的工具。 */
  extraTools?: Volatile<ExtraTool[]>
}

/** 配置 schema，默认值直接写在 schema 里。字段加 volatile 才会出现在设置表单中。 */
export const Config: Schema<{ extraTools?: ExtraTool[] }, Config> = Schema.object({
  extraTools: Schema.array(Schema.object({
    name: Schema.string().required(),
    pathKey: Schema.string(),
    oldKey: Schema.string(),
    newKey: Schema.string(),
    contentKey: Schema.string(),
  })).default([]).volatile(),
})

/**
 * 插件 apply：把入口配置声明成设置表单。
 * @param ctx - cordis 上下文。
 * @param config - 插件配置，解析后的值由浏览器半身经配置表单读取。
 */
export function apply(ctx: Context, _config: Config = {}): void {
  ctx.inject(['settings'], (settingsCtx) => {
    // 子级指明策略所属的插件 fiber，业务插件无需 Settings 即可运行。
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
}
