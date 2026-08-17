import { Hono } from 'hono'
import { getVersion } from '../lib/version.js'

const app = new Hono()

/**
 * GET /api/version — the running build's version, and nothing else.
 *
 * Split out from `/health` because the version is displayed on unauthenticated
 * surfaces (the login footer, the About dialog). `/health` answers the same
 * question, but only after probing the database, both data directories and
 * every execution engine — far too much work, and far too much detail, for
 * rendering a string on a public page load.
 */
app.get('/', (c) => c.json({ version: getVersion() }))

export default app
