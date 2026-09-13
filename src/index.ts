/**
 * 主机端：把本插件的 cordis 配置注册成 settings 命名空间，供浏览器端读取。
 *
 * 浏览器半身拿不到 cordis 配置：__DSH_BOOT__ 的 entry 不含 config 字段，客户端内核创建插件时也不传 config。
 * installSection 把 entry 配置注册为 base 层，用户分节覆盖其上，client 半身用 ctx.settingsScope 读解析值。
 *
 * 没有挂载 settings provider 时 installSection 退回 entry 值，浏览器端的 edit/write 卡片不受影响，只是 extraTools 不生效。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

/** 插件名，即配置条目 id。 */
export const name = 'dsh-edit-diff'

/** settings 命名空间，与包名一致，浏览器半身按同名绑定。 */
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

/** 插件配置。 */
export interface Config {
  /** 除 edit 与 write 外，额外接管 diff 卡片显示的工具。 */
  extraTools?: ExtraTool[]
}

/** 配置 schema，默认值直接写在 schema 里。 */
export const Config: Schema<Config> = Schema.object({
  extraTools: Schema.array(Schema.object({
    name: Schema.string().required(),
    pathKey: Schema.string(),
    oldKey: Schema.string(),
    newKey: Schema.string(),
    contentKey: Schema.string(),
  })).default([]),
})

/**
 * 插件 apply：把 entry 配置注册成 settings 命名空间。
 * @param ctx - cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: () => {},
      onChange: () => {},
    })
  })
}
