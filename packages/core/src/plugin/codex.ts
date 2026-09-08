import { Config as ConfigSchema } from "@opencode-ai/schema/config"
import { ConfigMCP } from "@opencode-ai/schema/config/mcp"
import { Plugin } from "@opencode-ai/schema/plugin"
import { Global } from "@opencode-ai/util/global"
import { Effect } from "effect"
import { readdir, readFile, stat } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "path"
import { Config } from "../config.js"

type ServerConfig = typeof ConfigMCP.Server.Type

type Candidate = {
  readonly info: Omit<Plugin.CodexInfo, "installed">
  readonly root: string
  readonly lineage: string
  readonly skills?: string
  readonly servers: ReadonlyArray<readonly [string, ServerConfig]>
}

export class InvalidError extends Error {}

export const list = Effect.fn("CodexPlugin.list")(function* () {
  const config = yield* Config.Service
  const current = yield* config.global()
  const candidates = yield* discover(path.join(Global.Path.home, ".codex", "plugins", "cache"))
  return candidates.map((candidate) => status(candidate, current))
})

export const install = Effect.fn("CodexPlugin.install")(function* (id: string) {
  const config = yield* Config.Service
  const candidates = yield* discover(path.join(Global.Path.home, ".codex", "plugins", "cache"))
  const candidate = candidates.find((item) => item.info.id === id)
  if (!candidate) return yield* Effect.fail(new InvalidError(`Codex plugin is unavailable: ${id}`))
  if (!candidate.skills && !candidate.servers.length)
    return yield* Effect.fail(
      new InvalidError(`${candidate.info.displayName} only exposes ChatGPT-hosted apps or unsupported hooks.`),
    )

  const current = yield* config.global()
  const skills = candidate.skills
    ? [...(current.skills ?? []).filter((item) => !localPathInside(candidate.lineage, item)), candidate.skills].filter(
        (item, index, all) => all.findIndex((other) => samePath(item, other)) === index,
      )
    : undefined
  const servers = { ...current.mcp?.servers }
  for (const [name, server] of candidate.servers) {
    const existing = servers[name]
    if (existing && !isDeepStrictEqual(existing, server) && !ownedBy(existing, candidate.lineage))
      return yield* Effect.fail(
        new InvalidError(`MCP server "${name}" already has a different global configuration in opencode.json.`),
      )
    servers[name] = server
  }

  const updated = yield* config.updateGlobal(
    new ConfigSchema.Info({
      ...(skills ? { skills } : {}),
      ...(candidate.servers.length
        ? {
            mcp: new ConfigMCP.Info({
              ...(current.mcp?.timeout ? { timeout: current.mcp.timeout } : {}),
              servers,
            }),
          }
        : {}),
    }),
  )
  return status(candidate, updated)
})

function status(candidate: Candidate, config: ConfigSchema.Info): Plugin.CodexInfo {
  const skills = !candidate.skills || (config.skills ?? []).some((item) => samePath(item, candidate.skills!))
  const servers = candidate.servers.every(([name, server]) => isDeepStrictEqual(config.mcp?.servers?.[name], server))
  const supported = candidate.info.compatible.skills + candidate.info.compatible.mcp
  return { ...candidate.info, installed: supported > 0 && skills && servers }
}

function discover(cache: string) {
  return Effect.gen(function* () {
    const manifests = yield* Effect.promise(() => manifestFiles(cache))
    const loaded = yield* Effect.forEach(manifests.toSorted(), (manifest) => load(cache, manifest), { concurrency: 8 })
    const candidates: Candidate[] = []
    for (const candidate of loaded) if (candidate) candidates.push(candidate)
    const latest = new Map<string, Candidate>()
    for (const candidate of candidates) {
      const key = `${candidate.info.source}/${candidate.info.name}`
      const previous = latest.get(key)
      if (!previous || natural.compare(previous.info.version, candidate.info.version) < 0) latest.set(key, candidate)
    }
    return Array.from(latest.values()).sort((a, b) => natural.compare(a.info.displayName, b.info.displayName))
  })
}

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

function load(cache: string, manifestFile: string) {
  return Effect.gen(function* () {
    const relative = path.relative(cache, manifestFile)
    const parts = relative.split(path.sep)
    if (parts.length !== 5 || parts[3] !== ".codex-plugin" || parts[4] !== "plugin.json") return undefined
    const source = parts[0]
    const packageName = parts[1]
    const folderVersion = parts[2]
    if (!safeSegment(source) || !safeSegment(packageName) || !safeSegment(folderVersion)) return undefined
    const raw = yield* readJson(manifestFile)
    if (!record(raw) || !shortString(raw.name) || !shortString(raw.version)) return undefined
    const root = path.dirname(path.dirname(manifestFile))
    const skills = yield* declaredDirectory(root, raw.skills)
    const skillFiles = skills ? yield* Effect.promise(() => skillFilesIn(skills)) : []
    const mcp = yield* loadMcp(root, raw.mcpServers)
    const displayName =
      record(raw.interface) && shortString(raw.interface.displayName)
        ? raw.interface.displayName.trim()
        : raw.name.trim()
    const description = shortString(raw.description) ? raw.description.trim().slice(0, 1_000) : undefined
    const features = {
      skills: skillFiles.length,
      mcp: mcp.total,
      apps: typeof raw.apps === "string",
      hooks: record(raw.hooks),
    }
    return {
      info: {
        id: [source, packageName, folderVersion].join("/"),
        name: raw.name.trim(),
        displayName,
        ...(description ? { description } : {}),
        version: raw.version.trim(),
        source,
        features,
        compatible: { skills: skillFiles.length, mcp: mcp.servers.length },
      },
      root,
      lineage: path.dirname(root),
      ...(skillFiles.length ? { skills } : {}),
      servers: mcp.servers,
    } satisfies Candidate
  })
}

function loadMcp(root: string, declared: unknown) {
  return Effect.gen(function* () {
    const file = safeDeclaredPath(root, declared)
    if (!file || !(yield* isFile(file))) return { total: 0, servers: [] as Array<readonly [string, ServerConfig]> }
    const raw = yield* readJson(file)
    const definitions = record(raw) && record(raw.mcpServers) ? raw.mcpServers : {}
    const entries = Object.entries(definitions).filter(([name]) => safeName(name))
    const servers = entries.flatMap(([name, value]) => {
      const server = decodeServer(root, value)
      return server ? [[name, server] as const] : []
    })
    return { total: entries.length, servers }
  })
}

function decodeServer(root: string, value: unknown): ServerConfig | undefined {
  if (!record(value) || value.enabled === false) return undefined
  if (value.type === "http" || value.type === "sse") {
    if (!shortString(value.url)) return undefined
    const url = URL.parse(value.url)
    if (!url || !["http:", "https:"].includes(url.protocol)) return undefined
    const headers = safeEnvironment(value.headers)
    if (!headers) return undefined
    if (value.bearer_token_env_var !== undefined) {
      if (!environmentName(value.bearer_token_env_var)) return undefined
      headers.Authorization = `Bearer {env:${value.bearer_token_env_var}}`
    }
    return new ConfigMCP.Remote({
      type: "remote",
      url: url.href,
      ...(Object.keys(headers).length ? { headers } : {}),
    })
  }
  if (!shortString(value.command)) return undefined
  const args = value.args === undefined ? [] : stringArray(value.args)
  if (!args || args.length > 128 || args.some((item) => item.length > 4_096)) return undefined
  const cwd = safeDeclaredPath(root, value.cwd ?? ".")
  if (!cwd) return undefined
  const environment = safeEnvironment(value.env)
  if (!environment) return undefined
  if (value.env_vars !== undefined) {
    const names = stringArray(value.env_vars)
    if (!names || names.some((name) => !environmentName(name))) return undefined
    for (const name of names) environment[name] = `{env:${name}}`
  }
  const seconds = typeof value.startup_timeout_sec === "number" ? value.startup_timeout_sec : undefined
  const startup =
    seconds && Number.isFinite(seconds) && seconds > 0 && seconds <= 600 ? Math.round(seconds * 1_000) : undefined
  return new ConfigMCP.Local({
    type: "local",
    command: [value.command.trim(), ...args],
    cwd,
    ...(Object.keys(environment).length ? { environment } : {}),
    ...(startup ? { timeout: new ConfigMCP.Timeout({ startup }) } : {}),
  })
}

function declaredDirectory(root: string, declared: unknown) {
  const target = safeDeclaredPath(root, declared)
  if (!target) return Effect.succeed(undefined)
  return isDirectory(target).pipe(Effect.map((exists) => (exists ? target : undefined)))
}

function safeDeclaredPath(root: string, declared: unknown) {
  if (!shortString(declared) || path.isAbsolute(declared)) return undefined
  const target = path.resolve(root, declared)
  return contains(root, target) ? target : undefined
}

function safeEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (!record(value)) return undefined
  const result: Record<string, string> = {}
  for (const [name, input] of Object.entries(value)) {
    if (!environmentName(name) || typeof input !== "string") return undefined
    const match = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(input)
    const variable = match?.[1] ?? match?.[2]
    if (!variable) return undefined
    result[name] = `{env:${variable}}`
  }
  return result
}

function ownedBy(server: ServerConfig, lineage: string) {
  return server.type === "local" && !!server.cwd && contains(lineage, path.resolve(server.cwd))
}

function localPathInside(parent: string, value: string) {
  if (URL.canParse(value) && /^(https?:)$/.test(new URL(value).protocol)) return false
  return contains(parent, path.resolve(value))
}

function samePath(a: string, b: string) {
  if (URL.canParse(a) || URL.canParse(b)) return a === b
  return process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b)
}

async function manifestFiles(cache: string) {
  const result: string[] = []
  for (const source of await directories(cache)) {
    for (const plugin of await directories(path.join(cache, source))) {
      for (const version of await directories(path.join(cache, source, plugin))) {
        result.push(path.join(cache, source, plugin, version, ".codex-plugin", "plugin.json"))
      }
    }
  }
  return result
}

async function directories(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && safeSegment(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function readJson(file: string) {
  return Effect.promise(async () => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as unknown
    } catch {
      return undefined
    }
  })
}

function isFile(file: string) {
  return Effect.promise(async () => {
    try {
      return (await stat(file)).isFile()
    } catch {
      return false
    }
  })
}

function isDirectory(directory: string) {
  return Effect.promise(async () => {
    try {
      return (await stat(directory)).isDirectory()
    } catch {
      return false
    }
  })
}

async function skillFilesIn(directory: string) {
  const result: string[] = []
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 4 || result.length >= 1_000) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "SKILL.md") result.push(path.join(current, entry.name))
      if (entry.isDirectory()) await visit(path.join(current, entry.name), depth + 1)
      if (result.length >= 1_000) return
    }
  }
  await visit(directory, 0)
  return result
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

function shortString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096
}

function safeSegment(value: string) {
  return value.length > 0 && value.length <= 200 && value !== "." && value !== ".." && !/[\\/]/.test(value)
}

function safeName(value: string) {
  return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._-]+$/.test(value)
}

function environmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}
