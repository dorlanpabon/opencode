import type { PluginCodexInfo } from "@opencode-ai/client"
import { Badge } from "@opencode-ai/ui/badge"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tabs } from "@opencode-ai/ui/tabs"
import { TextInput } from "@opencode-ai/ui/text-input"
import { Component, For, Show, createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useMcpToggle } from "@/providers/connect/mcp"
import { pluginLabels } from "@/providers/catalog/plugin"
import { ExternalLink } from "@/runtime/platform/external-link"
import { InlineServerSelect } from "@/settings/server-select"
import { showToast } from "@/shell/notifications/toast"
import "@/settings/settings.css"

interface McpRowItem {
  name: string
  enabled: boolean
}

interface PluginRowItem {
  name: string
}

export const SettingsExtensions: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const data = useData()
  const [mcpList, { refetch: refetchMcp }] = createResource(
    () => serverSdk.connection.status() === "connected",
    () => serverSdk.api.mcp.list().then((result) => result.data),
    { initialValue: [] },
  )
  const toggleMcp = useMcpToggle(() => undefined, refetchMcp)
  const mcps = createMemo<McpRowItem[]>(() => {
    return (mcpList.latest ?? []).map((server) => ({
      name: server.name,
      enabled: server.status.status === "connected",
    }))
  })

  const handleMcpToggle = (item: McpRowItem, checked: boolean) => {
    if (item.enabled === checked || toggleMcp.isPending) return
    toggleMcp.mutate(item.name)
  }

  const [pluginList] = createResource(
    () => serverSdk.connection.status() === "connected",
    () => serverSdk.api.plugin.list().then((result) => result.data),
    { initialValue: [] },
  )
  const plugins = createMemo<PluginRowItem[]>(() => pluginLabels(pluginList.latest ?? []).map((name) => ({ name })))
  const [codexList, { refetch: refetchCodex }] = createResource(
    () => serverSdk.connection.status() === "connected",
    () => serverSdk.api.plugin.codex.list(),
    { initialValue: [] },
  )
  const [store, setStore] = createStore({ search: "", installing: "" })
  const codexPlugins = createMemo(() => {
    const search = store.search.trim().toLowerCase()
    if (!search) return codexList.latest ?? []
    return (codexList.latest ?? []).filter((plugin) =>
      [plugin.displayName, plugin.name, plugin.source, plugin.description ?? ""].some((value) =>
        value.toLowerCase().includes(search),
      ),
    )
  })
  const installable = (plugin: PluginCodexInfo) => plugin.compatible.skills + plugin.compatible.mcp > 0
  const installCodex = async (plugin: PluginCodexInfo) => {
    if (store.installing) return
    setStore("installing", plugin.id)
    try {
      await serverSdk.api.plugin.codex.install({ id: plugin.id })
      await Promise.all([refetchCodex(), refetchMcp(), data.location.skill.sync()])
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.extensions.codex.installedToast", { plugin: plugin.displayName }),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStore("installing", "")
    }
  }

  createEffect(() => {
    if (serverSdk.connection.status() !== "connected") return
    void data.location.skill.sync().catch(() => undefined)
  })
  const skills = () => data.location.skill.list() ?? []

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.extensions")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.extensions.description")}</span>
          </div>
          <InlineServerSelect />
        </div>
      </div>

      <div class="settings-tab-body">
        <Tabs variant="pill" defaultValue="mcps" class="settings-extensions-tabs">
          <Tabs.List>
            <Tabs.Trigger value="mcps">{language.t("settings.extensions.tab.mcps")}</Tabs.Trigger>
            <Tabs.Trigger value="plugins">{language.t("status.popover.tab.plugins")}</Tabs.Trigger>
            <Tabs.Trigger value="skills">{language.t("settings.extensions.tab.skills")}</Tabs.Trigger>
            <Tabs.Trigger value="codex">{language.t("settings.extensions.tab.codex")}</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="mcps">
            <div class="settings-section">
              <div class="flex items-center justify-between">
                <span class="text-13-medium text-v2-text-text-base">
                  {language.t("settings.extensions.availableAll")}
                </span>
                <span class="text-13-regular text-v2-text-faint">{language.t("settings.extensions.manageConfig")}</span>
              </div>
              <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] pl-4 pr-3 overflow-hidden">
                <For each={mcps()}>
                  {(item) => (
                    <div class="py-4 flex items-center justify-between border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                      <div class="flex items-center gap-2.5 min-w-0">
                        <Icon name="mcp" class="text-v2-icon-icon-muted shrink-0" />
                        <span class="text-13-medium text-v2-text-text-base truncate">{item.name}</span>
                      </div>
                      <Switch checked={item.enabled} onChange={(checked) => handleMcpToggle(item, checked)} hideLabel>
                        {item.name}
                      </Switch>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="plugins">
            <div class="settings-section">
              <div class="flex items-center justify-between">
                <span class="text-13-medium text-v2-text-text-base">
                  {language.t("settings.extensions.availableAll")}
                </span>
                <span class="text-13-regular text-v2-text-faint">{language.t("settings.extensions.manageConfig")}</span>
              </div>
              <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] pl-4 pr-3 overflow-hidden">
                <For each={plugins()}>
                  {(plugin) => (
                    <div class="py-4 flex items-center justify-between border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                      <div class="flex items-center gap-2.5 min-w-0">
                        <Icon name="cube" class="text-v2-icon-icon-muted shrink-0" />
                        <span class="text-13-medium text-v2-text-text-base truncate font-mono">{plugin.name}</span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="skills">
            <div class="settings-section">
              <div class="flex items-center justify-between">
                <span class="text-13-medium text-v2-text-text-base">
                  {language.t("settings.extensions.availableAll")}
                </span>
                <ExternalLink
                  class="text-13-regular text-v2-text-accent hover:underline"
                  href="https://opencode.ai/docs/skills/"
                >
                  {language.t("settings.extensions.addSkills")}
                </ExternalLink>
              </div>
              <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] pl-4 pr-3 overflow-hidden">
                <For each={skills()}>
                  {(skill) => (
                    <div class="py-4 flex items-center justify-between border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                      <div class="flex items-center gap-2.5 min-w-0">
                        <Icon name="post-skill" class="text-v2-icon-icon-muted shrink-0" />
                        <span class="text-13-medium text-v2-text-text-base truncate">{skill.name}</span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Tabs.Content>

          <Tabs.Content value="codex">
            <div class="settings-section">
              <div class="flex flex-col gap-1">
                <span class="text-13-medium text-v2-text-text-base">
                  {language.t("settings.extensions.codex.title")}
                </span>
                <span class="text-11-regular text-v2-text-text-muted">
                  {language.t("settings.extensions.codex.description")}
                </span>
              </div>
              <TextInput
                type="search"
                appearance="base"
                class="!w-full self-stretch"
                value={store.search}
                onInput={(event) => setStore("search", event.currentTarget.value)}
                placeholder={language.t("settings.extensions.codex.search")}
                aria-label={language.t("settings.extensions.codex.search")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
              <Show
                when={!codexList.loading}
                fallback={<span class="text-13-regular text-v2-text-text-muted">{language.t("common.loading")}</span>}
              >
                <Show
                  when={codexPlugins().length > 0}
                  fallback={
                    <span class="text-13-regular text-v2-text-text-muted">
                      {language.t("settings.extensions.codex.empty")}
                    </span>
                  }
                >
                  <div class="bg-[var(--v2-background-bg-base)] border-[0.5px] border-[var(--v2-border-border-base)] rounded-[8px] px-4 overflow-hidden">
                    <For each={codexPlugins()}>
                      {(plugin) => (
                        <div class="py-3 flex items-center gap-3 border-b-[0.5px] border-[var(--v2-border-border-base)] last:border-b-0">
                          <Icon name="cube" class="text-v2-icon-icon-muted shrink-0" />
                          <div class="flex flex-col gap-1 min-w-0 flex-1">
                            <div class="flex items-center gap-2 min-w-0">
                              <span class="text-13-medium text-v2-text-text-base truncate">{plugin.displayName}</span>
                              <span class="text-11-regular text-v2-text-faint truncate font-mono">
                                {plugin.name}@{plugin.source} · {plugin.version}
                              </span>
                            </div>
                            <Show when={plugin.description}>
                              <span class="text-11-regular text-v2-text-text-muted line-clamp-2">
                                {plugin.description}
                              </span>
                            </Show>
                            <div class="flex items-center gap-1.5 flex-wrap">
                              <Show when={plugin.compatible.skills > 0}>
                                <Badge>{language.t("settings.extensions.codex.feature.skills")}</Badge>
                              </Show>
                              <Show when={plugin.compatible.mcp > 0}>
                                <Badge>{language.t("settings.extensions.codex.feature.mcp")}</Badge>
                              </Show>
                              <Show when={plugin.features.apps}>
                                <Badge>{language.t("settings.extensions.codex.feature.app")}</Badge>
                              </Show>
                              <Show when={plugin.features.hooks}>
                                <Badge>{language.t("settings.extensions.codex.feature.hooks")}</Badge>
                              </Show>
                            </div>
                          </div>
                          <Button
                            size="small"
                            variant={store.installing === plugin.id ? "loading" : "neutral"}
                            disabled={plugin.installed || !installable(plugin) || !!store.installing}
                            onClick={() => void installCodex(plugin)}
                          >
                            {plugin.installed
                              ? language.t("settings.extensions.codex.installed")
                              : installable(plugin)
                                ? language.t("settings.extensions.codex.install")
                                : language.t("settings.extensions.codex.requiresChatGPT")}
                          </Button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </Tabs.Content>
        </Tabs>
      </div>
    </>
  )
}
