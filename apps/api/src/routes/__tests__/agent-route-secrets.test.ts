import { describe, expect, it } from 'vitest'
import {
  preserveA2ARouteTargetSecrets,
  preserveSensitiveEnvSecrets,
} from '../agent-route-secrets.js'

describe('A2A route target credential preservation', () => {
  it('restores a masked legacy direct-route key after the UI adds explicit 0.3 defaults', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'legacy',
          url: 'https://legacy.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'legacy',
          url: 'https://legacy.example.com/a2a',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({
      ok: true,
      value: [
        {
          type: 'remote',
          name: 'legacy',
          url: 'https://legacy.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: 'stored-secret',
        },
      ],
    })
  })

  it('preserves a masked key when only the remote target display name changes', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'new-display-name',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'old-display-name',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({
      ok: true,
      value: [
        {
          type: 'remote',
          name: 'new-display-name',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: 'stored-secret',
        },
      ],
    })
  })

  it('refuses to carry a masked key to a changed endpoint or discovery mode', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://new.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://old.example.com/a2a',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({ ok: false, targetName: 'service' })
  })

  it('refuses to carry a masked key to a changed direct protocol version', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({ ok: false, targetName: 'service' })
  })

  it('does not reuse one stored key for two masked targets at the same endpoint', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'renamed-one',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: '********',
        },
        {
          type: 'remote',
          name: 'renamed-two',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'original',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({ ok: false, targetName: 'renamed-two' })
  })
})

describe('sensitive env credential preservation', () => {
  it('restores a masked value under an unchanged key', () => {
    const result = preserveSensitiveEnvSecrets(
      { API_TOKEN: { value: '********', sensitive: true } },
      { API_TOKEN: { value: 'stored-secret', sensitive: true } },
    )

    expect(result).toEqual({
      ok: true,
      value: { API_TOKEN: { value: 'stored-secret', sensitive: true } },
    })
  })

  /**
   * The regression this whole helper exists for: the UI round-trips the masked
   * placeholder verbatim, so renaming only the key used to look up the old value
   * by the *new* name, find nothing, and persist the literal '********' — silently
   * destroying a credential the user never intended to touch.
   */
  it('rejects a masked value whose key was renamed, instead of storing the placeholder', () => {
    const result = preserveSensitiveEnvSecrets(
      { API_TOKNE: { value: '********', sensitive: true } },
      { API_TOKEN: { value: 'stored-secret', sensitive: true } },
    )

    expect(result).toEqual({ ok: false, key: 'API_TOKNE' })
  })

  /**
   * With nothing stored at all there is no secret to strand, so the placeholder is
   * blanked rather than rejected — the user is typing into a fresh row and a 400 telling
   * them to "re-enter" a value that never existed would be pure obstruction.
   */
  it('blanks a masked value for a brand-new key with nothing stored', () => {
    const result = preserveSensitiveEnvSecrets(
      { NEW_TOKEN: { value: '********', sensitive: true } },
      null,
    )

    expect(result).toEqual({
      ok: true,
      value: { NEW_TOKEN: { value: '', sensitive: true } },
    })
  })

  /**
   * The rename must still be rejected when a real secret is on the line: that is the
   * data-loss case the whole helper exists to prevent.
   */
  it('still rejects a rename while another key holds a real secret', () => {
    const result = preserveSensitiveEnvSecrets(
      {
        API_TOKNE: { value: '********', sensitive: true },
        OTHER: { value: '********', sensitive: true },
      },
      {
        API_TOKEN: { value: 'stored-secret', sensitive: true },
        OTHER: { value: 'other-secret', sensitive: true },
      },
    )

    expect(result).toEqual({ ok: false, key: 'API_TOKNE' })
  })

  /**
   * The eye toggle flips `sensitive` on an existing row in place, keeping the value.
   * Once the round-trip has replaced that value with dots, the stored plaintext is
   * still the only copy of it — restoring is what the user means by "mark this secret",
   * and rejecting would demand they retype a value the UI no longer shows them.
   */
  it('restores the stored value when a plaintext entry is newly marked sensitive', () => {
    const result = preserveSensitiveEnvSecrets(
      { DB_URL: { value: '********', sensitive: true } },
      { DB_URL: { value: 'postgres://u:p@h/db', sensitive: false } },
    )

    expect(result).toEqual({
      ok: true,
      value: { DB_URL: { value: 'postgres://u:p@h/db', sensitive: true } },
    })
  })

  /**
   * Clone and import both persist `{value: '', sensitive: true}` deliberately — the
   * row is kept so the user knows to refill it. `maskSensitiveEnv` masks it anyway,
   * so the form round-trips dots over an empty value. Rejecting would make every
   * cloned Agent unsavable until each blank secret was typed in, including when the
   * edit was to an unrelated field.
   */
  it('restores an empty stored value rather than blocking the save', () => {
    const result = preserveSensitiveEnvSecrets(
      { API_TOKEN: { value: '********', sensitive: true } },
      { API_TOKEN: { value: '', sensitive: true } },
    )

    expect(result).toEqual({
      ok: true,
      value: { API_TOKEN: { value: '', sensitive: true } },
    })
  })

  /**
   * A stored placeholder is a row already corrupted by the pre-fix bug. Rejecting would
   * make those Agents — precisely the ones this fix exists for — unsavable in every
   * field until the credential is retyped, with the UI showing dots and giving no hint
   * that env is the blocker. Blanking heals the row in place instead: the bad value
   * stops being injected at runtime, the field reads as empty and asks to be filled,
   * and the unrelated edit the user actually came to make goes through.
   */
  it('blanks a stored placeholder rather than blocking the save', () => {
    const result = preserveSensitiveEnvSecrets(
      { API_TOKEN: { value: '********', sensitive: true } },
      { API_TOKEN: { value: '********', sensitive: true } },
    )

    expect(result).toEqual({
      ok: true,
      value: { API_TOKEN: { value: '', sensitive: true } },
    })
  })

  /**
   * Renaming a key whose stored value is blank has nothing to lose — there is no secret
   * to strand — so it must not be rejected with a message demanding the user "re-enter"
   * a value that never existed.
   */
  it('allows renaming a key whose stored value was empty', () => {
    const result = preserveSensitiveEnvSecrets(
      { API_TOKEN: { value: '********', sensitive: true } },
      { API_TOKNE: { value: '', sensitive: true } },
    )

    expect(result).toEqual({
      ok: true,
      value: { API_TOKEN: { value: '', sensitive: true } },
    })
  })

  it('passes through a freshly typed value that replaces the masked one', () => {
    const result = preserveSensitiveEnvSecrets(
      { API_TOKEN: { value: 'rotated-secret', sensitive: true } },
      { API_TOKEN: { value: 'stored-secret', sensitive: true } },
    )

    expect(result).toEqual({
      ok: true,
      value: { API_TOKEN: { value: 'rotated-secret', sensitive: true } },
    })
  })

  /**
   * A non-sensitive entry is returned in plaintext, so a literal '********' there
   * is the user's own text and must be stored as typed, not treated as a sentinel.
   */
  it('treats the placeholder as literal text on a non-sensitive entry', () => {
    const result = preserveSensitiveEnvSecrets(
      { MASK_STYLE: { value: '********', sensitive: false } },
      { MASK_STYLE: { value: '####', sensitive: false } },
    )

    expect(result).toEqual({
      ok: true,
      value: { MASK_STYLE: { value: '********', sensitive: false } },
    })
  })

  it('drops a removed key without disturbing the entries that remain', () => {
    const result = preserveSensitiveEnvSecrets(
      { KEPT: { value: '********', sensitive: true } },
      {
        KEPT: { value: 'kept-secret', sensitive: true },
        REMOVED: { value: 'removed-secret', sensitive: true },
      },
    )

    expect(result).toEqual({
      ok: true,
      value: { KEPT: { value: 'kept-secret', sensitive: true } },
    })
  })

  it('passes through null/undefined env without touching stored values', () => {
    expect(preserveSensitiveEnvSecrets(undefined, { A: { value: 's', sensitive: true } })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(preserveSensitiveEnvSecrets(null, { A: { value: 's', sensitive: true } })).toEqual({
      ok: true,
      value: null,
    })
  })
})

describe('sensitive env key swaps', () => {
  /**
   * Renaming two sensitive keys past each other cannot strand or cross a credential.
   * The submitted env is a key→value map, not an ordered list, so a "swap" is indis-
   * tinguishable from no change at all: each name still resolves to the secret stored
   * under that same name. This is the structural reason the env path needs no identity
   * matching, unlike `preserveA2ARouteTargetSecrets`, whose targets are an array where
   * position and display name can drift independently of the endpoint.
   */
  it('keeps each secret bound to its own key when two names are exchanged', () => {
    const result = preserveSensitiveEnvSecrets(
      {
        B_TOKEN: { value: '********', sensitive: true },
        A_TOKEN: { value: '********', sensitive: true },
      },
      {
        A_TOKEN: { value: 'secret-a', sensitive: true },
        B_TOKEN: { value: 'secret-b', sensitive: true },
      },
    )

    expect(result).toEqual({
      ok: true,
      value: {
        B_TOKEN: { value: 'secret-b', sensitive: true },
        A_TOKEN: { value: 'secret-a', sensitive: true },
      },
    })
  })
})
