/**
 * Publish tab → GitLab (`glab`) / GitHub (`gh`) repository trigger section.
 *
 * One component serves both channels: the two forges differ in vocabulary
 * (MR vs PR) but not in anything this form collects, so `provider` selects the
 * copy and everything else is shared. Fully controlled, like the other channel
 * sections, so `handlePublish` can still assemble one atomic payload.
 *
 * The CLI status strip is the part worth understanding. a2wave never installs
 * `glab`/`gh` and never stores a forge token — auth lives in the CLI's own
 * keyring — so the platform can only *report* what it finds and tell the user
 * which command to run. Surfacing that here turns an otherwise invisible
 * misconfiguration (a channel that publishes fine and then silently fails every
 * poll) into something the user sees while configuring.
 */

import {
  GIT_TRIGGER_EVENTS,
  GIT_TRIGGER_INTENT_PLACEHOLDERS,
  GIT_TRIGGER_MAX_INTERVAL_SECONDS,
  GIT_TRIGGER_MAX_REPOS,
  GIT_TRIGGER_MIN_INTERVAL_SECONDS,
  type GitTriggerCliStatus,
  type GitTriggerEvent,
  type GitTriggerProvider,
  type GitTriggerScope,
} from '@a2wave/shared'
import { Button, Checkbox, InputNumber, Switch } from 'antd'
import {
  AlertTriangle,
  CheckCircle2,
  FolderTree,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PromptEditor } from '@/components/prompt-editor'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { parseGitNamespaceUrl, parseGitRepoUrl } from '@/lib/git-repo-url'

/**
 * One repository row.
 *
 * `url` is what the user typed and what the input displays; `host` / `project`
 * are derived from it and are what actually gets saved. The raw text has to be
 * held separately rather than re-rendered from the parsed parts: reformatting
 * on every keystroke rewrites the text mid-word (re-inserting `https://`,
 * swallowing the `/` the user is about to type after a group name), so the
 * field fights back while it is being filled in.
 */
export interface GitTriggerRepoDraft {
  url: string
  project: string
  host: string
  /**
   * How wide this row reaches. Optional so a draft restored from a config
   * written before scopes existed reads as the project scope it was.
   */
  scope?: GitTriggerScope
}

/**
 * Builds a row from typed text, keeping the text and its parse in step.
 *
 * `provider` is required rather than inferred: the two forges disagree about
 * how deep a project path can be, and the hostname is not a reliable tell —
 * a GitHub Enterprise install may live at any name, so guessing left GHE URLs
 * carrying their routing segments into a project the backend then rejected.
 * The form always knows which channel it is rendering, so it says so.
 *
 * The scope picks the parser, because a group and a project are different
 * shapes: `acme` is a valid namespace but not a valid project, so
 * parsing a group with the project rules rejects the most ordinary group path
 * there is.
 */
export function toGitTriggerRepoDraft(
  url: string,
  provider: GitTriggerProvider,
  scope: GitTriggerScope = 'project',
): GitTriggerRepoDraft {
  const parsed = scope === 'group' ? parseGitNamespaceUrl(url) : parseGitRepoUrl(url, provider)
  return { url, ...parsed, scope }
}

/**
 * The channel's placeholders as bare names (`repo`, not `{{repo}}`).
 *
 * `PromptEditor` matches variable *names* inside the braces it finds, so the
 * shared list — which is written with braces because it doubles as the click-
 * to-insert chips — has to be unwrapped before it can be handed over.
 */
const GIT_TRIGGER_INTENT_PLACEHOLDER_NAMES = GIT_TRIGGER_INTENT_PLACEHOLDERS.map((placeholder) =>
  placeholder.replace(/[{}]/g, ''),
)

/**
 * i18n key for a provider's prefilled intent.
 *
 * The template is copy, not config, so it lives in the locale files and follows
 * the UI language — an English-speaking user configuring a channel should not
 * have to first delete a Chinese prompt. Exported because `publish-tab` seeds
 * new drafts with the same value the reset button restores; two independent
 * defaults would make "Reset to default" reset to something the form never
 * showed.
 */
export function gitTriggerIntentDefaultKey(provider: GitTriggerProvider): string {
  return provider === 'glab' ? 'agentPublish.glabIntentDefault' : 'agentPublish.ghIntentDefault'
}

/**
 * Resolves the prefilled intent for `provider`.
 *
 * The template's `{{repo}}` and friends are placeholders the *API* substitutes
 * when an event fires, and they share i18next's interpolation syntax. That is
 * safe: i18next leaves a placeholder alone when no matching variable is passed,
 * so the raw template reaches the textarea intact. The accompanying test pins
 * that behaviour rather than trusting it, since a future interpolation config
 * change would otherwise gut every prefilled prompt silently.
 */
export function resolveGitTriggerIntentDefault(
  provider: GitTriggerProvider,
  t: (key: string) => string,
): string {
  return t(gitTriggerIntentDefaultKey(provider))
}

export interface GitTriggerChannelSectionProps {
  provider: GitTriggerProvider
  repos: GitTriggerRepoDraft[]
  onReposChange: (repos: GitTriggerRepoDraft[]) => void
  events: GitTriggerEvent[]
  onEventsChange: (events: GitTriggerEvent[]) => void
  intervalSeconds: number
  onIntervalSecondsChange: (value: number) => void
  intent: string
  onIntentChange: (value: string) => void
  targetBranches: string
  onTargetBranchesChange: (value: string) => void
  ignoreDrafts: boolean
  onIgnoreDraftsChange: (value: boolean) => void
  cliStatus: GitTriggerCliStatus | null
  cliStatusLoading: boolean
  onCheckCliStatus: () => void
}

export function GitTriggerChannelSection({
  provider,
  repos,
  onReposChange,
  events,
  onEventsChange,
  intervalSeconds,
  onIntervalSecondsChange,
  intent,
  onIntentChange,
  targetBranches,
  onTargetBranchesChange,
  ignoreDrafts,
  onIgnoreDraftsChange,
  cliStatus,
  cliStatusLoading,
  onCheckCliStatus,
}: GitTriggerChannelSectionProps) {
  const { t } = useTranslation()
  const isGitlab = provider === 'glab'
  const binary = isGitlab ? 'glab' : 'gh'
  const defaultIntent = resolveGitTriggerIntentDefault(provider, t)

  const updateRepo = (index: number, patch: Partial<GitTriggerRepoDraft>) => {
    onReposChange(repos.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)))
  }

  const toggleEvent = (event: GitTriggerEvent, checked: boolean) => {
    onEventsChange(checked ? [...events, event] : events.filter((e) => e !== event))
  }

  return (
    <div className="space-y-5">
      {/* No heading: the dialog title already names the channel, so repeating
          it here just pushed the actual explanation down a line. */}
      <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
        {t('agentPublish.gitTriggerSetupHelp')}
      </div>

      {/* CLI status — probed, never installed by the platform. */}
      <div className="space-y-2 rounded-lg bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between">
          <Label className="font-semibold">{t('agentPublish.gitTriggerCliStatus')}</Label>
          <Button
            size="small"
            onClick={onCheckCliStatus}
            loading={cliStatusLoading}
            icon={cliStatusLoading ? undefined : <RefreshCw className="h-3.5 w-3.5" />}
          >
            {t('agentPublish.gitTriggerCheckCli')}
          </Button>
        </div>
        {cliStatusLoading && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('agentPublish.gitTriggerCheckingCli')}
          </p>
        )}
        {!cliStatusLoading && !cliStatus && (
          <p className="text-xs text-muted-foreground">{t('agentPublish.gitTriggerCliUnknown')}</p>
        )}
        {!cliStatusLoading && cliStatus && (
          <div className="space-y-1.5">
            {/* Badge, not antd's `Tag color="success"`: the preset renders
                antd's own bright green, which ignores the theme's status
                tokens and reads as a foreign colour next to every other
                status surface in the app. */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={cliStatus.installed ? 'success' : 'destructive'}>
                {binary}{' '}
                {t(
                  cliStatus.installed
                    ? 'agentPublish.gitTriggerInstalled'
                    : 'agentPublish.gitTriggerNotInstalled',
                )}
              </Badge>
              <Badge variant={cliStatus.authenticated ? 'success' : 'warning'}>
                {t(
                  cliStatus.authenticated
                    ? 'agentPublish.gitTriggerAuthenticated'
                    : 'agentPublish.gitTriggerNotAuthenticated',
                )}
              </Badge>
              {cliStatus.account && <Badge variant="outline">{cliStatus.account}</Badge>}
            </div>
            {cliStatus.installed && cliStatus.authenticated ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {t('agentPublish.gitTriggerCliReady')}
              </p>
            ) : (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>
                  {cliStatus.detail ?? t('agentPublish.gitTriggerCliNotReady')}
                  <br />
                  {t('agentPublish.gitTriggerCliSelfManaged', { binary })}
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Repositories */}
      <div className="space-y-2">
        <Label required>{t('agentPublish.gitTriggerRepos')}</Label>
        <p className="text-xs text-muted-foreground">
          {t(isGitlab ? 'agentPublish.glabRepoHint' : 'agentPublish.ghRepoHint')}
        </p>
        <div className="space-y-3">
          {repos.map((repo, index) => {
            const scope = repo.scope ?? 'project'
            const invalid = repo.url.trim().length > 0 && !repo.project
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorderable only by add/remove
              <div key={index} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  {/* GitLab only: the gh listing is a per-repository GraphQL
                      query with no org-wide equivalent carrying head SHA and
                      comment counts, so offering the choice there would let the
                      user save a config the poller cannot honour. */}
                  {isGitlab ? (
                    // Label on its own row above the control, per the design
                    // doc — sharing a row with the delete button made the picker
                    // read as a toolbar affordance rather than the field it is.
                    <div className="flex flex-col items-start gap-1.5">
                      <Label className="text-sm">{t('agentPublish.gitTriggerScopeLabel')}</Label>
                      <ModePicker
                        value={scope}
                        onChange={(value) =>
                          // Re-parse rather than carry the text across: the same
                          // string means different things under the two parsers,
                          // so keeping the old parse would leave the row showing
                          // a project path while claiming to watch a group.
                          updateRepo(index, toGitTriggerRepoDraft(repo.url, provider, value))
                        }
                        options={[
                          {
                            value: 'project',
                            label: t('agentPublish.gitTriggerScopeProject'),
                            icon: GitBranch,
                          },
                          {
                            value: 'group',
                            label: t('agentPublish.gitTriggerScopeGroup'),
                            icon: FolderTree,
                          },
                        ]}
                      />
                    </div>
                  ) : (
                    <span />
                  )}
                  <Button
                    danger
                    type="text"
                    disabled={repos.length <= 1}
                    onClick={() => onReposChange(repos.filter((_, i) => i !== index))}
                    icon={<Trash2 className="h-4 w-4" />}
                    aria-label={t('agentPublish.gitTriggerRemoveRepo')}
                  />
                </div>
                <input
                  value={repo.url}
                  onChange={(event) =>
                    updateRepo(index, toGitTriggerRepoDraft(event.target.value, provider, scope))
                  }
                  placeholder={t(
                    scope === 'group'
                      ? 'agentPublish.gitTriggerGroupPlaceholder'
                      : isGitlab
                        ? 'agentPublish.glabRepoPlaceholder'
                        : 'agentPublish.ghRepoPlaceholder',
                  )}
                  className={`w-full min-w-0 rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary ${
                    invalid ? 'border-destructive' : 'border-border'
                  }`}
                />
                {/* Echo the split back: the config stores host and project
                    separately and the poll uses them separately, so the user
                    can see what their URL actually resolved to. */}
                {invalid && (
                  <p className="text-xs text-destructive">
                    {t(
                      scope === 'group'
                        ? 'agentPublish.gitTriggerGroupInvalid'
                        : 'agentPublish.gitTriggerRepoInvalid',
                    )}
                  </p>
                )}
                {!invalid && repo.project && (
                  <p className="text-xs text-muted-foreground">
                    {repo.host
                      ? t(
                          scope === 'group'
                            ? 'agentPublish.gitTriggerGroupParsed'
                            : 'agentPublish.gitTriggerRepoParsed',
                          { host: repo.host, project: repo.project },
                        )
                      : t(
                          scope === 'group'
                            ? 'agentPublish.gitTriggerGroupParsedDefaultHost'
                            : 'agentPublish.gitTriggerRepoParsedDefaultHost',
                          { project: repo.project },
                        )}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <Button
          size="small"
          disabled={repos.length >= GIT_TRIGGER_MAX_REPOS}
          onClick={() =>
            onReposChange([...repos, { url: '', project: '', host: '', scope: 'project' }])
          }
          icon={<Plus className="h-3.5 w-3.5" />}
        >
          {t('agentPublish.gitTriggerAddRepo')}
        </Button>
      </div>

      {/* Events */}
      <div className="space-y-2">
        <Label required>{t('agentPublish.gitTriggerEvents')}</Label>
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3">
          {GIT_TRIGGER_EVENTS.map((event) => (
            <Checkbox
              key={event}
              checked={events.includes(event)}
              onChange={(e) => toggleEvent(event, e.target.checked)}
            >
              {t(`agentPublish.gitTriggerEvent_${event}${isGitlab ? '_mr' : '_pr'}`)}
            </Checkbox>
          ))}
        </div>
      </div>

      {/* Interval */}
      <div className="space-y-2">
        <Label required>{t('agentPublish.gitTriggerInterval')}</Label>
        <div className="flex items-center gap-2">
          <InputNumber
            min={GIT_TRIGGER_MIN_INTERVAL_SECONDS}
            max={GIT_TRIGGER_MAX_INTERVAL_SECONDS}
            value={intervalSeconds}
            onChange={(value) => onIntervalSecondsChange(Number(value) || 0)}
            addonAfter={t('agentPublish.gitTriggerSeconds')}
          />
          <span className="text-xs text-muted-foreground">
            {t('agentPublish.gitTriggerIntervalHint', {
              min: GIT_TRIGGER_MIN_INTERVAL_SECONDS,
              max: GIT_TRIGGER_MAX_INTERVAL_SECONDS,
            })}
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>{t('agentPublish.gitTriggerTargetBranches')}</Label>
          <input
            value={targetBranches}
            onChange={(event) => onTargetBranchesChange(event.target.value)}
            placeholder="main, dev"
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
          <p className="text-xs text-muted-foreground">
            {t('agentPublish.gitTriggerTargetBranchesHint')}
          </p>
        </div>
        {/* No filled surface here: this sits beside a plain labelled input, so
            a tinted panel made one of two peer filters look like a callout. */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="text-sm font-medium">
              {t('agentPublish.gitTriggerIgnoreDrafts')}
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('agentPublish.gitTriggerIgnoreDraftsHint')}
            </p>
          </div>
          <Switch checked={ignoreDrafts} onChange={onIgnoreDraftsChange} />
        </div>
      </div>

      {/* Intent template */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label required>{t('agentPublish.gitTriggerIntent')}</Label>
          {/* The field is prefilled, so the escape hatch from an edit the user
              regrets is a reset rather than retyping the template by hand. */}
          <Button
            size="small"
            type="text"
            onClick={() => onIntentChange(defaultIntent)}
            disabled={intent === defaultIntent}
            icon={<RotateCcw className="h-3.5 w-3.5" />}
          >
            {t('agentPublish.gitTriggerIntentReset')}
          </Button>
        </div>
        {/* The same editor the system prompt uses, so a `{{title}}` here reads
            as the substituted variable it is instead of as literal text.
            The channel's placeholders are passed as `envKeys`: they are not
            PromptEditor's builtins, and without declaring them every one of
            them would highlight as an undefined variable — an amber warning
            across the entire prefilled template. */}
        <PromptEditor
          value={intent}
          onChange={onIntentChange}
          placeholder={t(
            isGitlab ? 'agentPublish.glabIntentPlaceholder' : 'agentPublish.ghIntentPlaceholder',
          )}
          envKeys={GIT_TRIGGER_INTENT_PLACEHOLDER_NAMES}
          // ~8 lines at the editor's 13px/1.4 metrics, plus its 8px padding.
          // The default 240px is sized for the full-page system prompt and
          // crowded out the placeholder chips inside this dialog.
          minHeightClassName="[&_.cm-editor]:min-h-[10.5rem]"
        />
        <div className="flex flex-wrap gap-1.5">
          {GIT_TRIGGER_INTENT_PLACEHOLDERS.map((placeholder) => (
            <button
              key={placeholder}
              type="button"
              onClick={() => onIntentChange(`${intent}${placeholder}`)}
              className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            >
              {placeholder}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('agentPublish.gitTriggerIntentHint')}</p>
      </div>
    </div>
  )
}
