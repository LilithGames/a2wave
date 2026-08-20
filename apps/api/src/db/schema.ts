/**
 * The schema every consumer imports — resolved to the active dialect.
 *
 * Table objects are not just names: drizzle reads column metadata off them to
 * decide how to encode each bound value. Importing the SQLite tables while
 * talking to PostgreSQL therefore does not merely mistype a column, it sends
 * *SQLite's* encoding to a PostgreSQL server — a `Date` goes out as epoch
 * seconds and every timestamp comparison fails with "date/time field value out
 * of range". That is exactly how this was found, on the run queue's
 * `created_at < cutoff` sweep against a real 9.6 server.
 *
 * Dispatching here rather than at the ~80 import sites keeps every consumer
 * (and every test that mocks `db/schema.js`) unchanged.
 *
 * The re-export is typed as the SQLite schema deliberately. The two are
 * structurally identical in the ways application code touches them — same table
 * names, same column names, same TypeScript column types — but their drizzle
 * brands differ, and picking one keeps the call sites free of dialect-aware
 * generics. `db` in client.ts is narrowed the same way, for the same reason.
 */
import { isPostgresRuntime } from './dialect-runtime.js'
import * as pg from './schema.pg.js'
import * as sqlite from './schema.sqlite.js'

const active = (isPostgresRuntime() ? pg : sqlite) as unknown as typeof sqlite

export const users = active.users
export const userInvitations = active.userInvitations
export const auditLogs = active.auditLogs
export const providers = active.providers
export const mcpServers = active.mcpServers
export const skillGroups = active.skillGroups
export const skills = active.skills
export const kbDocuments = active.kbDocuments
export const scmSources = active.scmSources
export const agents = active.agents
export const runs = active.runs
export const chatMessages = active.chatMessages
export const runSteps = active.runSteps
export const attachmentRefs = active.attachmentRefs
export const a2aTasks = active.a2aTasks
export const feishuPendingMessages = active.feishuPendingMessages
export const feishuCardCallbacks = active.feishuCardCallbacks
export const artifacts = active.artifacts
export const artifactShares = active.artifactShares
export const settings = active.settings
export const agentMembers = active.agentMembers
export const evaluationSets = active.evaluationSets
export const evaluationCases = active.evaluationCases
export const evaluationTasks = active.evaluationTasks
export const scmWorkloadLeases = active.scmWorkloadLeases
export const scmWorkspaceRemovals = active.scmWorkspaceRemovals
export const instanceHeartbeats = active.instanceHeartbeats
export const evaluationResults = active.evaluationResults
export const cliInstallations = active.cliInstallations
export const gitTriggerStates = active.gitTriggerStates
export const deviceAuthorizations = active.deviceAuthorizations
export const cliTokens = active.cliTokens
